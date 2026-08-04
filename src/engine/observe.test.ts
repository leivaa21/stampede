import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../metrics/index.ts";
import { brokenCheckCounter, EngineMetric } from "./metric-names.ts";
import { observeResponse, recorderFor, type ResponseObservers } from "./observe.ts";
import type { TransportResponse } from "./ports.ts";

/**
 * Where user-written code runs on the hot path, once per response, inside a worker.
 *
 * The whole job of this file is to let that code say what it has to say without letting it end the
 * run — so what is worth testing is the *taxonomy*: a `false` is a failure, a throw is a broken
 * check, and neither is allowed to stop anything.
 */

const response = (over: Partial<TransportResponse> = {}): TransportResponse => ({
  status: 200,
  headers: {},
  text: "{}",
  ...over,
});

const scenario = () => new MetricsRegistry().scenario("reads");

/** Mirrors what `dispatcher.ts` builds once per scenario. */
const observers = (
  metrics: ReturnType<typeof scenario>,
  parts: {
    checks?: Record<string, (response: TransportResponse) => boolean>;
    onResponse?: ResponseObservers["onResponse"];
  },
): ResponseObservers => ({
  checks: Object.entries(parts.checks ?? {}),
  onResponse: parts.onResponse,
  recorder: recorderFor(metrics),
});

describe("checks", () => {
  it("counts a passing check against its name", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, { checks: { ok: (r) => r.status === 200 } }),
      response(),
    );

    expect(metrics.checks.get("ok")).toEqual({ passed: 1, failed: 0 });
  });

  it("counts a failing check as a failure, which is the point of the feature", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, { checks: { ok: (r) => r.status === 201 } }),
      response({ status: 409 }),
    );

    expect(metrics.checks.get("ok")).toEqual({ passed: 0, failed: 1 });
    // A genuine failure is not a broken check.
    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(0);
  });

  it("treats a check that throws as broken, not as the target failing", () => {
    // D2-04, and the same split D1-06 makes for thresholds: a bug in an assertion must not be
    // reported as the target violating an invariant.
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, {
        checks: {
          boom: () => {
            throw new Error("typo in the check");
          },
        },
      }),
      response(),
    );

    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(1);
    // Named, so a report can say *which* claim is broken — and NOT written into `failed`, which
    // would have the checks table accuse the target of failing a check that never ran.
    expect(metrics.counters.get(brokenCheckCounter("boom"))).toBe(1);
    expect(metrics.checks.get("boom")).toEqual({ passed: 0, failed: 0 });
  });

  it("treats a check returning a non-boolean as broken", () => {
    // Node strips the user's types without checking them, so `(r) => { r.status === 200 }` —
    // braces instead of parens — returns undefined. Counting that as a failure blames the target.
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, { checks: { braces: (() => undefined) as unknown as () => boolean } }),
      response(),
    );

    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(1);
  });

  it("keeps running the other checks after one throws", () => {
    // A run must not lose every claim because one of them has a typo.
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, {
        checks: {
          boom: () => {
            throw new Error("nope");
          },
          fine: () => true,
        },
      }),
      response(),
    );

    expect(metrics.checks.get("fine")).toEqual({ passed: 1, failed: 0 });
  });

  it("records every named check, not just the first", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, { checks: { a: () => true, b: () => false, c: () => true } }),
      response(),
    );

    expect(metrics.checks.get("a").passed).toBe(1);
    expect(metrics.checks.get("b").failed).toBe(1);
    expect(metrics.checks.get("c").passed).toBe(1);
  });
});

describe("async callbacks", () => {
  it("does not let an async check take the process down", async () => {
    // TypeScript assigns `() => Promise<boolean>` to a `() => boolean` parameter without
    // complaint, so nothing upstream stops this — and an unhandled rejection from a worker takes
    // the whole run with it, publishing nothing.
    const metrics = scenario();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      observeResponse(
        metrics,
        observers(metrics, {
          checks: {
            asyncCheck: (() => Promise.reject(new Error("async boom"))) as unknown as () => boolean,
          },
        }),
        response(),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // A promise is not a boolean, so it is a broken check like any other non-boolean.
    expect(metrics.counters.get(brokenCheckCounter("asyncCheck"))).toBe(1);
  });

  it("routes an undeclared key to `other` rather than creating a name", () => {
    const metrics = scenario();
    const recorder = recorderFor(metrics, new Map([["byStatus", new Set(["2xx"])]]));

    recorder.countKeyed("byStatus", "2xx");
    recorder.countKeyed("byStatus", "418");

    expect(metrics.counters.get("byStatus.2xx")).toBe(1);
    expect(metrics.counters.get("byStatus.other")).toBe(1);
    // The undeclared key must not become a slot of its own — that is the cardinality bomb the
    // whole declaration exists to defuse.
    expect(metrics.counters.get("byStatus.418")).toBe(0);
  });

  it("refuses a counter the scenario never declared, and counts the refusal", () => {
    const metrics = scenario();
    const recorder = recorderFor(metrics, new Map([["byStatus", new Set(["2xx"])]]));

    recorder.countKeyed("byRoute", "/health");

    // There is no bounded slot to put it in, and inventing one is the thing being prevented. So it
    // is refused — and counted, because a refusal nobody counts is a silent hole.
    expect(metrics.counters.get("byRoute.other")).toBe(0);
    expect(metrics.counters.get(EngineMetric.undeclaredCounters)).toBe(1);
  });

  it("leaves an ordinary return value alone", () => {
    const metrics = scenario();
    // Only a *thenable* is a swallowed promise. An `onResponse` whose last expression happens to be
    // an object — `(r, record) => record.count("x")` returning undefined, or a builder returning a
    // config — did its work synchronously and is not broken.
    observeResponse(
      metrics,
      observers(metrics, { onResponse: () => ({ then: "not a function" }) }),
      response(),
    );

    expect(metrics.counters.get(EngineMetric.brokenObservers)).toBe(0);
  });

  it("does not let an async onResponse take the process down", async () => {
    const metrics = scenario();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      observeResponse(
        metrics,
        observers(metrics, {
          // What an `async` onResponse in a user's config compiles to. `load.ts` rejects it at
          // startup, but a promise still has to be survivable here: the engine is exported for
          // programmatic use, where nothing goes through the config loader at all.
          onResponse: () => Promise.reject(new Error("async boom")),
        }),
        response(),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Not merely survived: counted. An `onResponse` that returns a promise does its work after
      // the run has published, so a run whose config incremented a counter on every response would
      // otherwise report zero of it with nothing on the page saying why.
      expect(metrics.counters.get(EngineMetric.brokenObservers)).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});

describe("the reserved namespace", () => {
  it("refuses a user counter that would rewrite an engine number", () => {
    // The engine and the user write into the same map, so this would have made a run report
    // four hundred dropped requests that never happened.
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, {
        onResponse: (_r, record) => {
          record.count("stampede.dropped", 100);
        },
      }),
      response(),
    );

    expect(metrics.counters.get(EngineMetric.dropped)).toBe(0);
    expect(metrics.counters.get(EngineMetric.reservedNameRefusals)).toBe(1);
  });

  it("refuses a reserved trend name too", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, {
        onResponse: (_r, record) => {
          record.recordMs("stampede.latency", 5);
        },
      }),
      response(),
    );

    expect(metrics.counters.get(EngineMetric.reservedNameRefusals)).toBe(1);
  });
});

describe("onResponse", () => {
  it("counts what the user asks it to count", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, {
        onResponse: (r, record) => {
          if (r.status === 201) {
            record.count("reserved201");
          }
        },
      }),
      response({ status: 201 }),
    );

    expect(metrics.counters.get("reserved201")).toBe(1);
  });

  it("adds by an amount when given one", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      observers(metrics, {
        onResponse: (_r, record) => {
          record.count("retries", 3);
        },
      }),
      response(),
    );

    expect(metrics.counters.get("retries")).toBe(3);
  });

  it("records a distribution, not just a total — contract run 4's behindMs", () => {
    const metrics = scenario();

    for (const behindMs of [10, 20, 30]) {
      observeResponse(
        metrics,
        observers(metrics, {
          onResponse: (r, record) => {
            record.recordMs("behindMs", (JSON.parse(r.text) as { behindMs: number }).behindMs);
          },
        }),
        response({ text: JSON.stringify({ behindMs }) }),
      );
    }

    const summary = metrics.findTrend("behindMs")?.summaryMs();
    expect(summary?.count).toBe(3);
    expect(summary?.maxMs).toBeGreaterThanOrEqual(30);
  });

  it("counts a throwing observer without ending the run", () => {
    const metrics = scenario();

    expect(() => {
      observeResponse(
        metrics,
        observers(metrics, {
          onResponse: () => {
            throw new Error("bad JSON, probably");
          },
        }),
        response(),
      );
    }).not.toThrow();

    expect(metrics.counters.get(EngineMetric.brokenObservers)).toBe(1);
  });

  it("does nothing at all when a scenario declares neither", () => {
    const metrics = scenario();

    observeResponse(metrics, observers(metrics, {}), response());

    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(0);
  });
});

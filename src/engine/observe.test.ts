import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../metrics/index.ts";
import { EngineMetric } from "./metric-names.ts";
import { observeResponse } from "./observe.ts";
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

describe("checks", () => {
  it("counts a passing check against its name", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      { checks: { ok: (r) => r.status === 200 }, onResponse: undefined },
      response(),
    );

    expect(metrics.checks.get("ok")).toEqual({ passed: 1, failed: 0 });
  });

  it("counts a failing check as a failure, which is the point of the feature", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      { checks: { ok: (r) => r.status === 201 }, onResponse: undefined },
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
      {
        checks: {
          boom: () => {
            throw new Error("typo in the check");
          },
        },
        onResponse: undefined,
      },
      response(),
    );

    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(1);
    expect(metrics.checks.get("boom")).toEqual({ passed: 0, failed: 1 });
  });

  it("treats a check returning a non-boolean as broken", () => {
    // Node strips the user's types without checking them, so `(r) => { r.status === 200 }` —
    // braces instead of parens — returns undefined. Counting that as a failure blames the target.
    const metrics = scenario();

    observeResponse(
      metrics,
      { checks: { braces: (() => undefined) as unknown as () => boolean }, onResponse: undefined },
      response(),
    );

    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(1);
  });

  it("keeps running the other checks after one throws", () => {
    // A run must not lose every claim because one of them has a typo.
    const metrics = scenario();

    observeResponse(
      metrics,
      {
        checks: {
          boom: () => {
            throw new Error("nope");
          },
          fine: () => true,
        },
        onResponse: undefined,
      },
      response(),
    );

    expect(metrics.checks.get("fine")).toEqual({ passed: 1, failed: 0 });
  });

  it("records every named check, not just the first", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      {
        checks: { a: () => true, b: () => false, c: () => true },
        onResponse: undefined,
      },
      response(),
    );

    expect(metrics.checks.get("a").passed).toBe(1);
    expect(metrics.checks.get("b").failed).toBe(1);
    expect(metrics.checks.get("c").passed).toBe(1);
  });
});

describe("onResponse", () => {
  it("counts what the user asks it to count", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      {
        checks: undefined,
        onResponse: (r, record) => {
          if (r.status === 201) {
            record.count("reserved201");
          }
        },
      },
      response({ status: 201 }),
    );

    expect(metrics.counters.get("reserved201")).toBe(1);
  });

  it("adds by an amount when given one", () => {
    const metrics = scenario();

    observeResponse(
      metrics,
      {
        checks: undefined,
        onResponse: (_r, record) => {
          record.count("retries", 3);
        },
      },
      response(),
    );

    expect(metrics.counters.get("retries")).toBe(3);
  });

  it("records a distribution, not just a total — contract run 4's behindMs", () => {
    const metrics = scenario();

    for (const behindMs of [10, 20, 30]) {
      observeResponse(
        metrics,
        {
          checks: undefined,
          onResponse: (r, record) => {
            record.recordMs("behindMs", (JSON.parse(r.text) as { behindMs: number }).behindMs);
          },
        },
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
        {
          checks: undefined,
          onResponse: () => {
            throw new Error("bad JSON, probably");
          },
        },
        response(),
      );
    }).not.toThrow();

    expect(metrics.counters.get(EngineMetric.brokenObservers)).toBe(1);
  });

  it("does nothing at all when a scenario declares neither", () => {
    const metrics = scenario();

    observeResponse(metrics, { checks: undefined, onResponse: undefined }, response());

    expect(metrics.counters.get(EngineMetric.brokenChecks)).toBe(0);
  });
});

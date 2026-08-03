import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./registry.ts";
import { expectSameHistogram } from "../test-support/histogram-diff.ts";
import type { RegistrySnapshot } from "./snapshots.ts";
import { ScenarioMetrics } from "./scenario-metrics.ts";
import {
  MAX_DISTINCT_DISTRIBUTIONS,
  MAX_DISTINCT_SCENARIOS,
  MAX_METRIC_NAME_LENGTH,
} from "./validate.ts";

const populate = (registry: MetricsRegistry, scenario: string, seed: number): MetricsRegistry => {
  const metrics = registry.scenario(scenario);
  for (let step = 1; step <= 10; step += 1) {
    metrics.histogram("latency").record(seed * step);
    metrics.trend("behindMs").recordMs(step);
    metrics.counters.inc("requests");
    metrics.checks.record("no double sell", step !== seed);
  }
  return registry;
};

const registryOf = (scenario: string, seed: number): MetricsRegistry =>
  populate(new MetricsRegistry(), scenario, seed);

/**
 * Exact snapshot equality without walking 17,408 buckets per histogram in JS.
 *
 * `toEqual` on a `RegistrySnapshot` compares every `Int32Array` element by element, and seven
 * orderings of a registry holding several histograms is enough to push this file past vitest's 5s
 * default on a loaded machine — which looks exactly like flakiness in a suite that is deterministic
 * by construction. Canonicalising to a string keeps the comparison exact (nothing is hashed or
 * sampled) and moves the byte-level work into `Buffer`.
 */
const canonical = (snapshot: RegistrySnapshot): string =>
  JSON.stringify(snapshot, (_key: string, value: unknown) => {
    if (value instanceof Int32Array) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
    }
    if (value instanceof Map) {
      // Sorted, so two equal snapshots cannot differ by insertion order — which `toEqual` would
      // have ignored and a naive stringify would not.
      return Object.fromEntries(
        [...(value as ReadonlyMap<string, unknown>)].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return value;
  });

const expectSameSnapshot = (actual: RegistrySnapshot, expected: RegistrySnapshot): void => {
  if (canonical(actual) === canonical(expected)) {
    return;
  }
  // Narrowed before failing, down to the bucket. `toBe` on two 90KB base64 walls names neither the
  // scenario nor the metric, which is a worse failure message than the slow comparison it replaced.
  for (const [scenario, metrics] of actual.scenarios) {
    const other = expected.scenarios.get(scenario);
    for (const kind of ["histograms", "trends"] as const) {
      for (const [metric, histogram] of metrics[kind]) {
        // Narrowed rather than asserted: a metric present on one side only is its own failure,
        // and it should name the metric rather than throw inside the diff.
        const counterpart = other?.[kind].get(metric);
        if (counterpart === undefined) {
          expect({ scenario, metric, present: false }).toEqual({ scenario, metric, present: true });
          continue;
        }
        expectSameHistogram(histogram, counterpart, { scenario, metric });
      }
    }
    expect({ scenario, counters: metrics.counters, checks: metrics.checks }).toEqual({
      scenario,
      counters: other?.counters,
      checks: other?.checks,
    });
  }
  // Anything the walk above did not reach — a scenario only `expected` has, a different sequence.
  expect(canonical(actual)).toBe(canonical(expected));
};

describe("MetricsRegistry", () => {
  it("keeps each scenario's metrics apart", () => {
    const registry = new MetricsRegistry();
    registry.scenario("reads").counters.inc("hit", 3);
    registry.scenario("writes").counters.inc("hit", 5);

    expect(registry.scenario("reads").counters.get("hit")).toBe(3);
    expect(registry.scenario("writes").counters.get("hit")).toBe(5);
    expect(registry.scenarioNames).toEqual(["reads", "writes"]);
  });

  it("returns the same metric instance for the same name", () => {
    const metrics = new MetricsRegistry().scenario("reads");
    metrics.histogram("latency").record(100);
    metrics.histogram("latency").record(200);

    expect(metrics.histogram("latency").count).toBe(2);
  });

  it("keeps a microsecond histogram and a millisecond trend of the same name apart", () => {
    const metrics = new MetricsRegistry().scenario("writes");
    metrics.histogram("lag").record(1_000);
    metrics.trend("lag").recordMs(2);

    expect(metrics.histogram("lag").max).toBe(1_000);
    expect(metrics.trend("lag").maxMs).toBe(2);
    expect(metrics.histogramNames).toEqual(["lag"]);
    expect(metrics.trendNames).toEqual(["lag"]);
  });

  it("rejects empty names everywhere they can be introduced", () => {
    const registry = new MetricsRegistry();

    expect(() => {
      registry.scenario("");
    }).toThrow(RangeError);
    expect(() => {
      registry.scenario("ok").histogram("");
    }).toThrow(RangeError);
    expect(() => {
      registry.scenario("ok").trend("");
    }).toThrow(RangeError);
  });
});

describe("MetricsRegistry scenario names", () => {
  // Config-derived, so unlike a data-derived metric name these throw: the same config fails the
  // same way every run, at startup, before any load is generated (see validate.ts).
  it("throws on an over-long scenario name rather than refusing it silently", () => {
    const registry = new MetricsRegistry();

    expect(() => {
      registry.scenario("x".repeat(MAX_METRIC_NAME_LENGTH + 1));
    }).toThrow(/at most/);
    expect(registry.scenarioNames).toEqual([]);
  });

  it("accepts a name exactly at the length limit", () => {
    const registry = new MetricsRegistry();
    const name = "x".repeat(MAX_METRIC_NAME_LENGTH);

    registry.scenario(name).counters.inc("hit");

    expect(registry.scenarioNames).toEqual([name]);
  });

  it("throws once a run holds too many scenarios, but keeps serving the existing ones", () => {
    const registry = new MetricsRegistry();
    for (let index = 0; index < MAX_DISTINCT_SCENARIOS; index += 1) {
      registry.scenario(`s${String(index)}`).counters.inc("hit");
    }

    expect(() => {
      registry.scenario("one-too-many");
    }).toThrow(/at most/);
    expect(registry.scenarioNames).toHaveLength(MAX_DISTINCT_SCENARIOS);
    expect(registry.scenario("s0").counters.get("hit")).toBe(1);
  });

  it("rejects a snapshot sequence that is not a tally", () => {
    const registry = registryOf("reads", 3);

    expect(() => registry.toSnapshot(-1)).toThrow(/sequence/);
    expect(() => registry.toSnapshot(1.5)).toThrow(/sequence/);
    expect(registry.toSnapshot(0).sequence).toBe(0);
  });
});

describe("MetricsRegistry reads do not mutate", () => {
  // A mistyped threshold predicate or report lookup must not conjure the thing it asked for: the
  // reporter iterates `scenarioNames`, so a phantom renders an empty section for a scenario that
  // never ran, and a threshold then reads zeroes that look like real measurements.
  it("does not create a scenario on a mistyped lookup", () => {
    const registry = registryOf("reads", 3);

    expect(registry.findScenario("reeds")).toBeUndefined();
    expect(registry.hasScenario("reeds")).toBe(false);
    expect(registry.scenarioNames).toEqual(["reads"]);
  });

  it("does not create a histogram or trend on a mistyped lookup", () => {
    const metrics = registryOf("reads", 3).scenario("reads");

    expect(metrics.findHistogram("latencies")).toBeUndefined();
    expect(metrics.findTrend("behind")).toBeUndefined();
    expect(metrics.hasHistogram("latencies")).toBe(false);
    expect(metrics.hasTrend("behind")).toBe(false);
    expect(metrics.histogramNames).toEqual(["latency"]);
    expect(metrics.trendNames).toEqual(["behindMs"]);
  });

  it("finds what is really there", () => {
    const metrics = registryOf("reads", 3).scenario("reads");

    expect(metrics.findHistogram("latency")?.count).toBe(10);
    expect(metrics.findTrend("behindMs")?.count).toBe(10);
  });

  it("leaves the snapshot identical after a failed lookup", () => {
    const registry = registryOf("reads", 3);
    const before = registry.toSnapshot(1);

    registry.findScenario("reeds");
    registry.scenario("reads").findHistogram("nope");

    expect(registry.toSnapshot(1)).toEqual(before);
  });
});

describe("ScenarioMetrics cardinality cap", () => {
  const overflowing = (): ScenarioMetrics => {
    const metrics = new MetricsRegistry().scenario("reads");
    for (let index = 0; index < MAX_DISTINCT_DISTRIBUTIONS + 5; index += 1) {
      metrics.histogram(`latency-${String(index)}`).record(1_000);
    }
    return metrics;
  };

  it("refuses distributions past the cap and counts every refusal", () => {
    const metrics = overflowing();

    expect(metrics.histogramNames).toHaveLength(MAX_DISTINCT_DISTRIBUTIONS);
    expect(metrics.refusedCount).toBe(5);
  });

  it("keeps serving the names admitted before the cap was reached", () => {
    const metrics = overflowing();

    metrics.histogram("latency-0").record(2_000);

    expect(metrics.findHistogram("latency-0")?.count).toBe(2);
    expect(metrics.findHistogram("latency-40")).toBeUndefined();
  });

  it("hands refused recordings one shared sink, not a fresh 68 KiB histogram each time", () => {
    const metrics = overflowing();

    expect(metrics.histogram("refused-a")).toBe(metrics.histogram("refused-b"));
  });

  it("refuses an absurdly long name even when there is room", () => {
    const metrics = new MetricsRegistry().scenario("reads");

    metrics.histogram("x".repeat(MAX_METRIC_NAME_LENGTH + 1)).record(1_000);

    expect(metrics.histogramNames).toEqual([]);
    expect(metrics.refusedCount).toBe(1);
  });

  it("carries refusals through a snapshot round-trip and adds them on merge", () => {
    const left = overflowing();
    const right = overflowing();

    const restored = ScenarioMetrics.fromSnapshot(structuredClone(left.toSnapshot()));

    expect(restored.refusedCount).toBe(5);
    expect(left.merge(right).refusedCount).toBe(10);
  });
});

describe("MetricsRegistry snapshots", () => {
  it("round-trips losslessly through structuredClone", () => {
    const registry = populate(registryOf("reads", 3), "writes", 7);

    const restored = MetricsRegistry.fromSnapshot(structuredClone(registry.toSnapshot(1)));

    expect(restored.toSnapshot(1)).toEqual(registry.toSnapshot(1));
    expect(restored.scenarioNames).toEqual(["reads", "writes"]);
    expect(restored.scenario("reads").histogram("latency").count).toBe(10);
    expect(restored.scenario("writes").trend("behindMs").count).toBe(10);
    expect(restored.scenario("reads").checks.get("no double sell")).toEqual({
      passed: 9,
      failed: 1,
    });
  });

  it("does not alias the registry it came from", () => {
    const registry = registryOf("reads", 3);
    const snapshot = registry.toSnapshot(1);

    registry.scenario("reads").counters.inc("requests", 100);

    expect(MetricsRegistry.fromSnapshot(snapshot).scenario("reads").counters.get("requests")).toBe(
      10,
    );
  });
});

describe("MetricsRegistry.merge", () => {
  it("leaves both operands untouched", () => {
    const left = registryOf("reads", 3);
    const right = registryOf("reads", 5);

    const merged = left.merge(right);

    expect(left.scenario("reads").counters.get("requests")).toBe(10);
    expect(right.scenario("reads").counters.get("requests")).toBe(10);
    expect(merged.scenario("reads").counters.get("requests")).toBe(20);
  });

  it("unions scenarios that only one side ran", () => {
    const merged = registryOf("reads", 3).merge(registryOf("writes", 5));

    expect(merged.scenarioNames).toEqual(["reads", "writes"]);
    expect(merged.scenario("reads").histogram("latency").count).toBe(10);
    expect(merged.scenario("writes").histogram("latency").count).toBe(10);
  });

  it("is commutative and associative across every ordering", () => {
    const a = populate(registryOf("reads", 3), "writes", 3);
    const b = populate(registryOf("reads", 5), "writes", 5);
    const c = registryOf("writes", 7);
    const expected = a.merge(b).merge(c).toSnapshot(1);

    for (const ordering of [
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ]) {
      const merged = ordering.reduce(
        (aggregate, registry) => aggregate.merge(registry),
        new MetricsRegistry(),
      );

      expectSameSnapshot(merged.toSnapshot(1), expected);
    }

    expectSameSnapshot(a.merge(b.merge(c)).toSnapshot(1), expected);
  });

  it("equals recording every worker's samples into one registry", () => {
    const workerCount = 4;
    const perWorker = Array.from({ length: workerCount }, (_, worker) =>
      registryOf("reads", worker + 1),
    );
    const single = new MetricsRegistry();
    for (let worker = 1; worker <= workerCount; worker += 1) {
      populate(single, "reads", worker);
    }

    const merged = perWorker.reduce(
      (aggregate, registry) => aggregate.merge(registry),
      new MetricsRegistry(),
    );

    expect(merged.toSnapshot(1)).toEqual(single.toSnapshot(1));
  });
});

import { describe, expect, it } from "vitest";
import { compareNames, mapByName, mergeByName } from "./by-name.ts";
import { MetricsRegistry } from "./registry.ts";

/**
 * Name ordering is the one property `toEqual` on a `Map` cannot see — it compares entries, not
 * insertion order — so without these tests both `.sort()` calls can be deleted and the rest of the
 * suite stays green. The docstring in `by-name.ts` claims reproducibility; this is what makes the
 * claim testable.
 */
const keysOf = (map: ReadonlyMap<string, unknown>): readonly string[] => [...map.keys()];

const sorted = (names: readonly string[]): readonly string[] => [...names].sort(compareNames);

describe("mapByName", () => {
  it("emits entries in name order, whatever order they were inserted in", () => {
    const inserted = new Map([
      ["zulu", 1],
      ["alpha", 2],
      ["mike", 3],
    ]);

    expect(keysOf(mapByName(inserted, (value) => value))).toEqual(["alpha", "mike", "zulu"]);
  });
});

describe("mergeByName", () => {
  it("emits the union in name order, whichever side each name came from", () => {
    const left = new Map([
      ["zulu", 1],
      ["alpha", 1],
    ]);
    const right = new Map([
      ["mike", 1],
      ["bravo", 1],
    ]);

    const merged = mergeByName(
      left,
      right,
      () => 0,
      (a, b) => a + b,
    );

    expect(keysOf(merged)).toEqual(["alpha", "bravo", "mike", "zulu"]);
  });
});

describe("snapshot key order is independent of merge order", () => {
  const workerRecording = (scenarios: readonly string[], metrics: readonly string[]) => {
    const registry = new MetricsRegistry();
    for (const scenario of scenarios) {
      for (const metric of metrics) {
        registry.scenario(scenario).histogram(metric).record(1_000);
        registry.scenario(scenario).counters.inc(metric);
      }
    }
    return registry;
  };

  it("orders scenarios and metrics identically however the workers are merged", () => {
    const first = workerRecording(["zulu", "alpha"], ["latency", "bytes"]);
    const second = workerRecording(["mike", "alpha"], ["queue", "latency"]);
    const third = workerRecording(["bravo"], ["ttfb"]);

    const forwards = first.merge(second).merge(third).toSnapshot(1);
    const backwards = third.merge(second).merge(first).toSnapshot(1);

    const expectedScenarios = ["alpha", "bravo", "mike", "zulu"];
    expect(keysOf(forwards.scenarios)).toEqual(expectedScenarios);
    expect(keysOf(backwards.scenarios)).toEqual(expectedScenarios);

    for (const name of expectedScenarios) {
      const forwardScenario = forwards.scenarios.get(name);
      const backwardScenario = backwards.scenarios.get(name);

      expect(keysOf(forwardScenario?.histograms ?? new Map())).toEqual(
        sorted(keysOf(forwardScenario?.histograms ?? new Map())),
      );
      expect(keysOf(forwardScenario?.histograms ?? new Map())).toEqual(
        keysOf(backwardScenario?.histograms ?? new Map()),
      );
      expect(keysOf(forwardScenario?.counters.totals ?? new Map())).toEqual(
        keysOf(backwardScenario?.counters.totals ?? new Map()),
      );
    }
  });

  it("orders a single registry's own snapshot too, not only merged ones", () => {
    const registry = workerRecording(["zulu", "alpha", "mike"], ["latency", "bytes"]);

    const snapshot = registry.toSnapshot(1);

    expect(keysOf(snapshot.scenarios)).toEqual(["alpha", "mike", "zulu"]);
    expect(keysOf(snapshot.scenarios.get("alpha")?.histograms ?? new Map())).toEqual([
      "bytes",
      "latency",
    ]);
  });
});

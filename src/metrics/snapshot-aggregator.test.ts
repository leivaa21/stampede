import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./registry.ts";
import { SnapshotAggregator } from "./snapshot-aggregator.ts";
import type { RegistrySnapshot } from "./snapshots.ts";

/**
 * One worker's cumulative timeline: the snapshot it would post after 1, 2, … `steps` requests.
 * Cumulative, not delta — each entry contains everything that worker has measured so far (D1-03).
 */
const cumulativeSnapshots = (latencyUs: number, steps: number): RegistrySnapshot[] => {
  const registry = new MetricsRegistry();
  return Array.from({ length: steps }, (_unused, step) => {
    const metrics = registry.scenario("reads");
    metrics.histogram("latency").record(latencyUs + step);
    metrics.counters.inc("requests");
    metrics.checks.record("status ok", true);
    return registry.toSnapshot(step + 1);
  });
};

const finalSnapshotOf = (snapshots: readonly RegistrySnapshot[]): RegistrySnapshot => {
  const last = snapshots.at(-1);
  if (last === undefined) {
    throw new Error("no snapshots");
  }
  return last;
};

const snapshotAt = (snapshots: readonly RegistrySnapshot[], step: number): RegistrySnapshot => {
  const snapshot = snapshots[step];
  if (snapshot === undefined) {
    throw new Error(`no snapshot at step ${String(step)}`);
  }
  return snapshot;
};

/** Reads through `findScenario`: an assertion helper must not create what it is checking for. */
const requestsIn = (registry: MetricsRegistry): number =>
  registry.findScenario("reads")?.counters.get("requests") ?? 0;

describe("SnapshotAggregator", () => {
  it("aggregates nothing before any worker reports", () => {
    const aggregator = new SnapshotAggregator();

    expect(aggregator.workerCount).toBe(0);
    expect(aggregator.aggregate().scenarioNames).toEqual([]);
  });

  it("sums the latest snapshot of every worker", () => {
    const aggregator = new SnapshotAggregator();
    aggregator.update("w0", finalSnapshotOf(cumulativeSnapshots(100, 5)));
    aggregator.update("w1", finalSnapshotOf(cumulativeSnapshots(200, 3)));

    expect(aggregator.workerCount).toBe(2);
    expect(requestsIn(aggregator.aggregate())).toBe(8);
  });

  it("replaces a worker's snapshot instead of accumulating it", () => {
    const timeline = cumulativeSnapshots(100, 4);
    const aggregator = new SnapshotAggregator();

    for (const snapshot of timeline) {
      aggregator.update("w0", snapshot);
    }

    expect(requestsIn(aggregator.aggregate())).toBe(4);
  });

  it("is unchanged by a duplicated snapshot", () => {
    const timeline = cumulativeSnapshots(100, 4);
    const once = new SnapshotAggregator();
    const twice = new SnapshotAggregator();

    once.update("w0", finalSnapshotOf(timeline));
    twice.update("w0", finalSnapshotOf(timeline));
    twice.update("w0", finalSnapshotOf(timeline));

    expect(twice.aggregate().toSnapshot(1)).toEqual(once.aggregate().toSnapshot(1));
    expect(twice.supersededCount).toBe(1);
  });

  it("is unchanged by dropped intermediate snapshots", () => {
    const timeline = cumulativeSnapshots(100, 6);
    const everySnapshot = new SnapshotAggregator();
    const lastOnly = new SnapshotAggregator();

    for (const snapshot of timeline) {
      everySnapshot.update("w0", snapshot);
    }
    lastOnly.update("w0", finalSnapshotOf(timeline));

    expect(lastOnly.aggregate().toSnapshot(1)).toEqual(everySnapshot.aggregate().toSnapshot(1));
  });

  /**
   * The third guarantee D1-03 claims. A final snapshot posted from an exit handler or a second
   * MessageChannel can land after a timer snapshot that was sent earlier; without the sequence,
   * "keep the last that arrived" rewinds a 100-request total back to 1.
   */
  it("ignores a stale snapshot that arrives after a newer one", () => {
    const timeline = cumulativeSnapshots(100, 100);
    const aggregator = new SnapshotAggregator();

    expect(aggregator.update("w0", finalSnapshotOf(timeline))).toBe(true);
    expect(requestsIn(aggregator.aggregate())).toBe(100);

    expect(aggregator.update("w0", snapshotAt(timeline, 0))).toBe(false);

    expect(requestsIn(aggregator.aggregate())).toBe(100);
    expect(aggregator.supersededCount).toBe(1);
  });

  it("gives the same aggregate whatever order one worker's snapshots arrive in", () => {
    const timeline = cumulativeSnapshots(100, 5);
    const inOrder = new SnapshotAggregator();
    const shuffled = new SnapshotAggregator();

    for (const snapshot of timeline) {
      inOrder.update("w0", snapshot);
    }
    for (const step of [3, 0, 4, 1, 2]) {
      shuffled.update("w0", snapshotAt(timeline, step));
    }

    expect(shuffled.aggregate().toSnapshot(1)).toEqual(inOrder.aggregate().toSnapshot(1));
    expect(requestsIn(shuffled.aggregate())).toBe(5);
  });

  it("tracks sequences per worker, not globally", () => {
    const first = cumulativeSnapshots(100, 3);
    const second = cumulativeSnapshots(200, 3);
    const aggregator = new SnapshotAggregator();

    // w1's sequence 1 must not be judged stale because w0 already reached sequence 3.
    aggregator.update("w0", finalSnapshotOf(first));
    expect(aggregator.update("w1", snapshotAt(second, 0))).toBe(true);

    expect(requestsIn(aggregator.aggregate())).toBe(4);
  });

  it("survives snapshots arriving interleaved across workers", () => {
    const first = cumulativeSnapshots(100, 3);
    const second = cumulativeSnapshots(200, 3);
    const interleaved = new SnapshotAggregator();
    const finalOnly = new SnapshotAggregator();

    for (let step = 0; step < 3; step += 1) {
      interleaved.update("w0", snapshotAt(first, step));
      interleaved.update("w1", snapshotAt(second, step));
    }
    finalOnly.update("w1", finalSnapshotOf(second));
    finalOnly.update("w0", finalSnapshotOf(first));

    expect(interleaved.aggregate().toSnapshot(1)).toEqual(finalOnly.aggregate().toSnapshot(1));
  });

  it("refuses a message that is not a snapshot", () => {
    const aggregator = new SnapshotAggregator();

    expect(() => aggregator.update("w0", { sequence: 1 })).toThrow(/scenarios/);
    expect(aggregator.workerCount).toBe(0);
  });

  it("equals recording every worker's samples into a single registry", () => {
    const workerLatencies = [100, 250, 900, 4_000];
    const aggregator = new SnapshotAggregator();
    const single = new MetricsRegistry();

    workerLatencies.forEach((latencyUs, worker) => {
      aggregator.update(`w${String(worker)}`, finalSnapshotOf(cumulativeSnapshots(latencyUs, 5)));
      const metrics = single.scenario("reads");
      for (let step = 0; step < 5; step += 1) {
        metrics.histogram("latency").record(latencyUs + step);
        metrics.counters.inc("requests");
        metrics.checks.record("status ok", true);
      }
    });

    expect(aggregator.aggregate().toSnapshot(1)).toEqual(single.toSnapshot(1));
  });
});

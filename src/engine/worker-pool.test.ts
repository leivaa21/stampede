import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FixtureSetupState } from "../test-support/worker-fixture.ts";
import { mergeProgress, runPool } from "./worker-pool.ts";

/**
 * The worker pool, across real threads.
 *
 * These spawn actual `worker_threads`. A simulated pool would test the merge arithmetic, which
 * `metrics/` already proves; the thing that is new here is that the arithmetic survives a
 * structured clone, a message port and a separate isolate — so the tests have to cross one.
 *
 * Kept small and short on purpose: a load tester's own suite should not take longer than the load
 * tests it runs.
 */

const FIXTURE = fileURLToPath(new URL("../test-support/worker-fixture.ts", import.meta.url));

const runFixture = async (
  setupState: FixtureSetupState,
  workerCount: number,
  extra: { readonly maxInFlight?: number } = {},
): ReturnType<typeof runPool> =>
  runPool({
    modulePath: FIXTURE,
    workerCount,
    maxInFlight: extra.maxInFlight ?? 64,
    drainTimeoutMs: 2_000,
    snapshotIntervalMs: 25,
    setupState,
  });

describe("a sharded run reproduces the single-threaded one", () => {
  it("dispatches every scheduled request exactly once across four workers", async () => {
    const state: FixtureSetupState = { kind: "burst", count: 200 };

    const one = await runFixture(state, 1);
    const four = await runFixture(state, 4);

    const reads = (outcome: Awaited<ReturnType<typeof runPool>>) => {
      const scenario = outcome.summary.scenarios[0];
      if (scenario === undefined) {
        throw new Error("the run reported no scenario");
      }
      return scenario;
    };

    // The headline property: four threads measured the same run one thread did.
    expect(reads(four).scheduledCount).toBe(200);
    expect(reads(four).scheduledCount).toBe(reads(one).scheduledCount);
    expect(reads(four).dispatchedCount).toBe(reads(one).dispatchedCount);
    expect(reads(four).responseCount).toBe(reads(one).responseCount);
    expect(reads(four).latencyMs?.count).toBe(reads(one).latencyMs?.count);
  }, 20_000);

  it("keeps both accounting identities on the merged run", async () => {
    const outcome = await runFixture({ kind: "burst", count: 120 }, 3);

    for (const scenario of outcome.summary.scenarios) {
      expect(scenario.dispatchedCount + scenario.droppedCount).toBe(scenario.scheduledCount);
      expect(scenario.responseCount + scenario.errorCount + scenario.abandonedCount).toBe(
        scenario.dispatchedCount,
      );
    }
  }, 20_000);

  it("merges a rate profile without losing or inventing a request", async () => {
    const outcome = await runFixture({ kind: "rate", count: 60, durationMs: 300 }, 3);
    const scenario = outcome.summary.scenarios[0];

    expect(scenario?.scheduledCount).toBe(18);
    expect(scenario?.dispatchedCount).toBe(18);
  }, 20_000);

  it("counts transport failures across workers rather than losing them", async () => {
    const outcome = await runFixture({ kind: "burst", count: 60, fails: true }, 3);
    const scenario = outcome.summary.scenarios[0];

    expect(scenario?.errorCount).toBe(60);
    expect(scenario?.responseCount).toBe(0);
    // Errors are counted, never timed — an instant refusal is not a fast response.
    expect(scenario?.latencyMs).toBeUndefined();
  }, 20_000);

  it("does not discard snapshots as superseded in normal operation", async () => {
    const outcome = await runFixture({ kind: "burst", count: 40 }, 2);

    // Non-zero would mean the protocol's ordering assumption stopped holding.
    expect(outcome.supersededSnapshots).toBe(0);
  }, 20_000);
});

describe("a pool that cannot run says so instead of hanging", () => {
  it("fails the run when the module does not exist", async () => {
    await expect(
      runPool({
        modulePath: "/definitely/not/a/module.ts",
        workerCount: 2,
        maxInFlight: 8,
        drainTimeoutMs: 100,
        snapshotIntervalMs: 25,
        setupState: { kind: "burst", count: 1 },
      }),
    ).rejects.toThrow(/worker-\d/);
  }, 20_000);

  it("refuses a budget too small to give every worker a slot, before spawning anything", async () => {
    await expect(runFixture({ kind: "burst", count: 10 }, 8, { maxInFlight: 4 })).rejects.toThrow(
      /at least the worker count/,
    );
  }, 20_000);
});

describe("mergeProgress", () => {
  it("adds up disjoint shards and keeps the run's own span", () => {
    const merged = mergeProgress([
      {
        elapsedMs: 900,
        maxObservedInFlight: 4,
        scenarios: [
          {
            name: "reads",
            scheduledCount: 5,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 800,
          },
        ],
      },
      {
        elapsedMs: 1_100,
        maxObservedInFlight: 3,
        scenarios: [
          {
            name: "reads",
            scheduledCount: 5,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 950,
          },
        ],
      },
    ]);

    expect(merged.scenarios[0]?.scheduledCount).toBe(10);
    // The run took as long as its slowest shard, not the sum of them.
    expect(merged.elapsedMs).toBe(1_100);
    // The window is the run's, not a shard's share of it.
    expect(merged.scenarios[0]?.requestedDurationMs).toBe(1_000);
    expect(merged.scenarios[0]?.lastDispatchElapsedMs).toBe(950);
    // An upper bound by construction — the shards' peaks need not have coincided.
    expect(merged.maxObservedInFlight).toBe(7);
  });

  it("keeps a scenario that only one shard ever dispatched", () => {
    const merged = mergeProgress([
      {
        elapsedMs: 10,
        maxObservedInFlight: 1,
        scenarios: [
          { name: "reads", scheduledCount: 1, requestedDurationMs: 0, lastDispatchElapsedMs: 0 },
        ],
      },
      {
        elapsedMs: 10,
        maxObservedInFlight: 0,
        scenarios: [
          {
            name: "reads",
            scheduledCount: 0,
            requestedDurationMs: 0,
            lastDispatchElapsedMs: undefined,
          },
        ],
      },
    ]);

    expect(merged.scenarios[0]?.lastDispatchElapsedMs).toBe(0);
  });
});

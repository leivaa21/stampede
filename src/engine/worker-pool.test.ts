import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("reports why the module could not be loaded, not merely that a worker left", async () => {
    // Asserting the *diagnostic*, not just any rejection: matching /worker-\d/ alone would be
    // satisfied by the exit handler's "exited before reporting its results", so deleting the whole
    // failure-reporting path in worker-entry.ts would still pass. It has to name the cause.
    await expect(
      runPool({
        modulePath: "/definitely/not/a/module.ts",
        workerCount: 2,
        maxInFlight: 8,
        drainTimeoutMs: 100,
        snapshotIntervalMs: 25,
        setupState: { kind: "burst", count: 1 },
      }),
    ).rejects.toThrow(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  }, 20_000);

  it("names the contract a module broke when it exports the wrong thing", async () => {
    await expect(
      runPool({
        modulePath: fileURLToPath(new URL("./schedule-split.ts", import.meta.url)),
        workerCount: 1,
        maxInFlight: 4,
        drainTimeoutMs: 100,
        snapshotIntervalMs: 25,
        setupState: { kind: "burst", count: 1 },
      }),
    ).rejects.toThrow(/must default-export a function/);
  }, 20_000);

  it("refuses a worker count of zero rather than reporting an empty run as a success", async () => {
    // Without the guard this resolves happily with no scenarios: the pre-validation loop never
    // runs and `Promise.all([])` resolves — a green run that generated no load at all.
    await expect(runFixture({ kind: "burst", count: 10 }, 0)).rejects.toThrow(/workerCount/);
  }, 20_000);

  it("refuses a snapshot interval that would flood the run", async () => {
    // 0 or NaN turns a one-second run into four seconds of posting thousands of registry clones —
    // the instrument perturbing its own measurement, from a config value.
    await expect(
      runPool({
        modulePath: FIXTURE,
        workerCount: 2,
        maxInFlight: 8,
        drainTimeoutMs: 100,
        snapshotIntervalMs: 0,
        setupState: { kind: "burst", count: 1 },
      }),
    ).rejects.toThrow(/snapshotIntervalMs/);
  }, 20_000);

  it("tears down the siblings of a worker that failed, instead of leaving them running", async () => {
    // Node does not report worker threads in `getActiveResourcesInfo()`, so liveness is measured
    // the only way it is observable from here: the surviving workers append to a file on every
    // dispatch, and a terminated worker stops appending.
    const heartbeatPath = join(mkdtempSync(join(tmpdir(), "stampede-pool-")), "beats");
    writeFileSync(heartbeatPath, "");

    // Shard 1 refuses to load; shards 0 and 2 carry a five-second schedule. Without teardown they
    // would keep dispatching long after the run rejected — a load tester that holds the process
    // open after printing its report.
    await expect(
      runFixture({ kind: "rate", count: 20, durationMs: 5_000, failOnShard: 1, heartbeatPath }, 3),
    ).rejects.toThrow(/fixture refused to load/);

    const atRejection = readFileSync(heartbeatPath, "utf8").length;
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(readFileSync(heartbeatPath, "utf8").length).toBe(atRejection);
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

  it("does not depend on the order the shards finished in", () => {
    // CLAUDE.md: anything merged across workers is tested for commutativity, because worker
    // completion order must never change a published number — and `progressByWorker` is iterated
    // in finish order, so this is fed a different permutation on every run.
    const parts = [
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
          {
            name: "writes",
            scheduledCount: 2,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 10,
          },
        ],
      },
      {
        elapsedMs: 1_100,
        maxObservedInFlight: 3,
        scenarios: [
          {
            name: "reads",
            scheduledCount: 4,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 950,
          },
          {
            name: "writes",
            scheduledCount: 3,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 40,
          },
        ],
      },
      {
        elapsedMs: 1_000,
        maxObservedInFlight: 2,
        scenarios: [
          {
            name: "reads",
            scheduledCount: 6,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 20,
          },
          {
            name: "writes",
            scheduledCount: 1,
            requestedDurationMs: 1_000,
            lastDispatchElapsedMs: 5,
          },
        ],
      },
    ];

    const forwards = mergeProgress(parts);
    const backwards = mergeProgress([...parts].reverse());
    const shuffled = mergeProgress([parts[2], parts[0], parts[1]].filter((p) => p !== undefined));

    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
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

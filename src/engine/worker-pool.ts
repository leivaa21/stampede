import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { SnapshotAggregator } from "../metrics/index.ts";
import { summariseRun, type RunProgress, type ScenarioProgress } from "./run-summary.ts";
import { shardMaxInFlight } from "./schedule-split.ts";
import { assertPositiveCount } from "./validate.ts";
import { parseWorkerMessage, type WorkerAssignment } from "./worker-protocol.ts";
import type { RunSummary } from "./run-summary.ts";

/**
 * Running one load test across several threads, and putting the pieces back together.
 *
 * D1-03: every worker owns its metrics, posts **cumulative** snapshots, and the main thread keeps
 * the newest per worker and re-merges. No shared mutable state and no atomics on the dispatch path
 * — the merge happens once a second on numbers that are already final, instead of on every request.
 *
 * The pieces fit because of two properties proven elsewhere: `schedule-split.ts` guarantees the
 * shards *are* the run, and `metrics/` guarantees the merge is exact, associative and commutative.
 * This file is where both are cashed in.
 */

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 1_000;

export interface PoolRunSpec {
  /** Absolute path to the module each worker imports. */
  readonly modulePath: string;
  readonly workerCount: number;
  /** The run's whole in-flight budget, divided across the workers. */
  readonly maxInFlight: number;
  readonly drainTimeoutMs: number;
  readonly setupState?: unknown;
  readonly snapshotIntervalMs?: number;
  /** Called on every snapshot, for a live view. Never called after the run resolves. */
  readonly onProgress?: (summary: RunSummary) => void;
}

export interface PoolRunOutcome {
  readonly summary: RunSummary;
  /**
   * Snapshots discarded for arriving after a newer one from the same worker.
   *
   * Expected to be zero in practice — one `MessagePort` per worker preserves send order. It is
   * reported rather than swallowed because a non-zero value means the protocol's ordering
   * assumption stopped holding, and that is worth knowing before it becomes a wrong published
   * number.
   */
  readonly supersededSnapshots: number;
}

const workerEntryUrl = new URL("worker-entry.ts", import.meta.url);

/**
 * Combines what each shard saw into the facts of one run.
 *
 * Merged rather than summarised per shard and then averaged: `summariseRun` derives the achieved
 * rate and the percentiles from raw counts, so it has to run **once, over the merged inputs**, or a
 * derived number would be derived from numbers that had already been shaped.
 */
export const mergeProgress = (parts: readonly RunProgress[]): RunProgress => {
  const scenarios = new Map<string, ScenarioProgress>();
  for (const part of parts) {
    for (const scenario of part.scenarios) {
      const seen = scenarios.get(scenario.name);
      scenarios.set(
        scenario.name,
        seen === undefined
          ? scenario
          : {
              name: scenario.name,
              // The shards are disjoint by construction, so their counts add up to the run's.
              scheduledCount: seen.scheduledCount + scenario.scheduledCount,
              // Identical across shards — a shard covers the same window, not a shorter one.
              requestedDurationMs: Math.max(seen.requestedDurationMs, scenario.requestedDurationMs),
              lastDispatchElapsedMs: maxDefined(
                seen.lastDispatchElapsedMs,
                scenario.lastDispatchElapsedMs,
              ),
            },
      );
    }
  }

  return {
    elapsedMs: Math.max(0, ...parts.map((part) => part.elapsedMs)),
    // A **sum of independent maxima**, so an upper bound rather than a measurement: the workers
    // peaked whenever they peaked, and nothing here says those peaks coincided. Bounding concurrent
    // memory is what this number is for, and for that an upper bound is the honest side to err on.
    maxObservedInFlight: parts.reduce((total, part) => total + part.maxObservedInFlight, 0),
    scenarios: [...scenarios.values()],
  };
};

const maxDefined = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.max(a, b);
};

/**
 * Runs the whole schedule across `workerCount` threads and returns the merged run.
 *
 * Every exit path tears the workers down. A load tester that leaves threads running holds the
 * process open after its report is printed; one that hangs waiting on a worker that already died
 * publishes nothing at all. Both are worse than a run that ends early and says why.
 */
export const runPool = async (spec: PoolRunSpec): Promise<PoolRunOutcome> => {
  assertPositiveCount(spec.workerCount, "workerCount");
  // Validated before a thread is spawned: a budget too small to give every worker a slot is a
  // config mistake, and it should fail at startup rather than as an unexplained wall of drops.
  for (let index = 0; index < spec.workerCount; index += 1) {
    shardMaxInFlight(spec.maxInFlight, { index, count: spec.workerCount });
  }

  const aggregator = new SnapshotAggregator();
  const progressByWorker = new Map<string, RunProgress>();
  const workers: Worker[] = [];

  const terminateAll = async (): Promise<void> => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  };

  try {
    await Promise.all(
      Array.from({ length: spec.workerCount }, async (_unused, index) => {
        const workerId = `worker-${String(index)}`;
        const assignment: WorkerAssignment = {
          modulePath: spec.modulePath,
          shardIndex: index,
          shardCount: spec.workerCount,
          maxInFlight: shardMaxInFlight(spec.maxInFlight, { index, count: spec.workerCount }),
          drainTimeoutMs: spec.drainTimeoutMs,
          snapshotIntervalMs: spec.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS,
          setupState: spec.setupState,
        };

        const worker = new Worker(fileURLToPath(workerEntryUrl), { workerData: assignment });
        workers.push(worker);

        await new Promise<void>((resolve, reject) => {
          worker.on("message", (raw: unknown) => {
            try {
              const message = parseWorkerMessage(raw);
              if (message.kind === "failed") {
                reject(new Error(`${workerId}: ${message.message}`));
                return;
              }
              aggregator.update(workerId, message.snapshot);
              if (message.kind === "finished") {
                progressByWorker.set(workerId, message.progress);
                resolve();
                return;
              }
              spec.onProgress?.(
                summariseRun(mergeProgress([...progressByWorker.values()]), aggregator.aggregate()),
              );
            } catch (error: unknown) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
          worker.on("error", (error: Error) => {
            reject(new Error(`${workerId} failed: ${error.message}`, { cause: error }));
          });
          // A worker that exits without a `finished` message took its slice of the schedule with
          // it. Reporting a run short of a whole shard as if it were complete would publish a
          // throughput number for load that was never generated.
          worker.on("exit", (code: number) => {
            reject(
              new Error(
                `${workerId} exited with code ${String(code)} before reporting its results`,
              ),
            );
          });
        });
      }),
    );
  } finally {
    await terminateAll();
  }

  return {
    summary: summariseRun(mergeProgress([...progressByWorker.values()]), aggregator.aggregate()),
    supersededSnapshots: aggregator.supersededCount,
  };
};

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { maxWorkerCount } from "../config/to-run.ts";
import { SnapshotAggregator } from "../metrics/index.ts";
import { summariseRun, type RunProgress, type ScenarioProgress } from "./run-summary.ts";
import { shardMaxInFlight } from "./schedule-split.ts";
import { assertDurationMs, assertPositiveCount, assertWorkerCount } from "./validate.ts";
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
  /** Path to the module each worker imports. Resolved against the process cwd if relative. */
  readonly modulePath: string;
  readonly workerCount: number;
  /** The run's whole in-flight budget, divided across the workers. */
  readonly maxInFlight: number;
  readonly drainTimeoutMs: number;
  readonly setupState?: unknown;
  readonly snapshotIntervalMs?: number;
  /**
   * Called with a merged summary each time a worker reports, for a live view.
   *
   * Correct only because every message — not just the final one — carries its worker's progress. A
   * merge that held metrics from all workers and progress from the finished ones alone reported an
   * empty run, and then one whose dispatched count exceeded its scheduled count. A consumer that
   * throws is isolated: a render bug must not abort the load test.
   */
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

/**
 * Where the worker entry lives, in whichever form this module is currently running.
 *
 * Running from `src/` it is a `.ts` file that Node type-strips; running from `dist/` it is the
 * bundled `.js`. Hardcoding either one produces a package whose every worker spawn fails with
 * `Cannot find module` — and no gate would catch it, because the tests run from `src` and
 * `pnpm build` only checks that the bundle *builds*. So the extension is taken from the module
 * doing the spawning, which is by definition the right one.
 */
const workerEntryUrl = new URL(
  import.meta.url.endsWith(".ts") ? "worker-entry.ts" : "worker-entry.js",
  import.meta.url,
);

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
  assertWorkerCount(spec.workerCount, maxWorkerCount(), "workerCount");
  assertDurationMs(spec.drainTimeoutMs, "drainTimeoutMs");
  const snapshotIntervalMs = spec.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  // An unvalidated interval reaches `setInterval` in every worker. Zero or NaN turns a one-second
  // run into four seconds of posting thousands of full registry clones — the instrument perturbing
  // its own measurement, from a config value. Config-derived, so it throws at startup.
  assertPositiveCount(snapshotIntervalMs, "snapshotIntervalMs");
  // Computed before a thread is spawned: a budget too small to give every worker a slot is a
  // config mistake, and it should fail at startup rather than as an unexplained wall of drops.
  const budgets = Array.from({ length: spec.workerCount }, (_unused, index) =>
    shardMaxInFlight(spec.maxInFlight, { index, count: spec.workerCount }),
  );

  const aggregator = new SnapshotAggregator();
  const progressByWorker = new Map<string, RunProgress>();
  const workers: Worker[] = [];

  /**
   * Outside the protocol's own error handling on purpose: a consumer that throws — a render bug on
   * frame three — must not abort the load test. `in-flight.ts` makes the same argument by name, and
   * a load tester that dies mid-run publishes nothing.
   */
  const publishProgress = (): void => {
    if (spec.onProgress === undefined) {
      return;
    }
    // Nothing is published until every worker has been heard from once. The merged progress is a
    // union over the workers that have reported, so an early frame states a fraction of the run's
    // schedule and a fraction of its *requested rate* — and the progress bar goes backwards as
    // later workers arrive. Under-reporting a static fact the config already fixed is the same
    // category of wrong as the bug this protocol change was made to kill.
    if (progressByWorker.size < spec.workerCount) {
      return;
    }
    const merged = summariseRun(
      mergeProgress([...progressByWorker.values()]),
      aggregator.aggregate(),
    );
    try {
      spec.onProgress(merged);
    } catch {
      // Deliberately swallowed: the run is the product, the live view is a convenience.
    }
  };

  // `allSettled`, not `all`: this runs in a `finally`, so a rejecting `terminate()` would replace
  // the real reason the run ended with a teardown error, and abandon the remaining terminations
  // while it did. Teardown must not be able to lie about why it was reached.
  const terminateAll = async (): Promise<void> => {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  };

  try {
    await Promise.all(
      Array.from({ length: spec.workerCount }, async (_unused, index) => {
        const workerId = `worker-${String(index)}`;
        const assignment: WorkerAssignment = {
          modulePath: spec.modulePath,
          shardIndex: index,
          shardCount: spec.workerCount,
          maxInFlight: budgets[index] ?? 1,
          drainTimeoutMs: spec.drainTimeoutMs,
          snapshotIntervalMs,
          setupState: spec.setupState,
        };

        // `setup()` returning something that cannot be structured-cloned is the single most likely
        // first-run mistake, because the natural thing to return is a *client* rather than data.
        // The raw DataCloneError names neither `setup()` nor the rule, so it is translated here.
        let worker: Worker;
        try {
          worker = new Worker(fileURLToPath(workerEntryUrl), { workerData: assignment });
        } catch (error: unknown) {
          // Only a clone failure is blamed on `setup()`. Catching everything here sent a user to
          // rewrite a `setup()` that was never the problem.
          if (!(error instanceof DOMException) || error.name !== "DataCloneError") {
            throw error;
          }
          const detail = error.message;
          throw new Error(
            `setup() returned something that cannot be sent to a worker: ${detail}\n\n` +
              "Every worker imports your config in its own thread, so setup state travels as data " +
              "(structured clone). Return plain values — an id, a token, a URL — and build clients " +
              "inside the scenario, not in setup().",
            { cause: error },
          );
        }
        workers.push(worker);

        await new Promise<void>((resolve, reject) => {
          worker.on("message", (raw: unknown) => {
            try {
              const message = parseWorkerMessage(raw);
              if (message.kind === "failed") {
                reject(new Error(`${workerId}: ${message.message}`));
                return;
              }
              // Progress follows the same ordering guard as the metrics: `update` reports whether
              // the snapshot advanced this worker's state, and a superseded message must not rewind
              // `elapsedMs` while the metrics correctly keep the newer one.
              const advanced = aggregator.update(workerId, message.snapshot);
              if (advanced || message.kind === "finished") {
                progressByWorker.set(workerId, message.progress);
              }
              if (message.kind === "finished") {
                resolve();
                return;
              }
              publishProgress();
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

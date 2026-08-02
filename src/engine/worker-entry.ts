import { parentPort, workerData } from "node:worker_threads";
import { loadConfig } from "../config/load.ts";
import { scenariosFrom } from "../config/to-run.ts";
import { MetricsRegistry } from "../metrics/index.ts";
import { LiveProgress, runDispatch } from "./dispatcher.ts";
import { httpTransport, type HttpRequestSpec } from "./http-transport.ts";
import { shardScenarios } from "./schedule-split.ts";
import { systemClock } from "./system-clock.ts";
import type { WorkerAssignment, WorkerMessage } from "./worker-protocol.ts";

/**
 * One worker thread: import the work, run its shard of the schedule, report what it measured.
 *
 * This file is the other half of D1-04's consequence. Functions cannot cross a `postMessage`, so a
 * worker cannot be handed a scenario's request builder — it is handed a module specifier and
 * imports the work itself, in its own isolate, exactly as the main thread would. That is why
 * `setup()` runs once on the main thread and returns **data**: the data is what travels.
 *
 * The worker owns a private `MetricsRegistry` and posts **cumulative** snapshots (D1-03). Nothing
 * is shared, nothing is locked, and the main thread's aggregate is a merge rather than a running
 * total it has to keep in step.
 */

const post = (message: WorkerMessage): void => {
  if (parentPort === null) {
    // A hard invariant, not a maybe: this file only ever runs as a worker. Optional chaining here
    // would make every message a silent no-op if that stopped being true, so the pool would wait
    // out the whole run to learn nothing was ever reported.
    throw new Error("worker-entry.ts must be run as a worker thread, not directly");
  }
  parentPort.postMessage(message);
};

const main = async (assignment: WorkerAssignment): Promise<void> => {
  // The worker imports the user's config *itself*, in its own isolate. That is not duplication of
  // the main thread's work — it is the only option: `request` is a function, and a function cannot
  // be structured-cloned across a `postMessage` (D1-04). Only the setup **state** travels.
  const config = await loadConfig(assignment.modulePath);
  const scenarios = scenariosFrom(config, assignment.setupState);
  const transport = httpTransport;
  const metrics = new MetricsRegistry();
  const shard = { index: assignment.shardIndex, count: assignment.shardCount };
  const live = new LiveProgress();

  // Cumulative snapshots on a timer, for the live view. Each carries a fresh sequence, so a
  // message delayed in flight can never rewind the aggregate it arrives at — and each carries this
  // worker's *progress*, without which a mid-run merge would hold metrics from every worker and
  // progress only from the finished ones, and report more dispatched than scheduled.
  let sequence = 0;
  const ticker = setInterval(() => {
    const progress = live.read();
    if (progress === undefined) {
      return; // the run has not started yet; there is nothing true to say
    }
    sequence += 1;
    post({ kind: "snapshot", snapshot: metrics.toSnapshot(sequence), progress });
  }, assignment.snapshotIntervalMs);
  // The run is what keeps this thread alive; the ticker must not extend it by itself.
  ticker.unref();

  try {
    const outcome = await runDispatch<HttpRequestSpec>(
      {
        scenarios: shardScenarios(scenarios, shard),
        maxInFlight: assignment.maxInFlight,
        drainTimeoutMs: assignment.drainTimeoutMs,
        // Without this every worker would number its dispatches from 0 and four threads would
        // build request 0 four times — "N buyers, N distinct seats" becoming four per seat.
        shard,
      },
      { clock: systemClock, transport, metrics, live },
    );
    // A *fresh* sequence, even though the timer may have just fired and nothing changed since.
    // `snapshots.ts` requires it: reusing the last one would make the final snapshot read as a
    // duplicate and be discarded, publishing a mid-run total as the run's result.
    sequence += 1;
    post({
      kind: "finished",
      snapshot: outcome.metrics.toSnapshot(sequence),
      progress: outcome.progress,
    });
  } finally {
    clearInterval(ticker);
  }
};

// A worker that cannot start must say so and exit, not hang. The pool is waiting on a message and
// would otherwise wait for the whole run's duration to learn that nothing was ever dispatched.
main(workerData as WorkerAssignment).catch((error: unknown) => {
  post({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
});

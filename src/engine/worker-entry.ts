import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { MetricsRegistry } from "../metrics/index.ts";
import { runDispatch } from "./dispatcher.ts";
import type { Transport } from "./ports.ts";
import type { Scenario } from "./run-spec.ts";
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

interface WorkerRun {
  readonly scenarios: readonly Scenario<unknown>[];
  readonly transport: Transport<unknown>;
}

const isRunShape = (value: unknown): value is WorkerRun =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { scenarios?: unknown }).scenarios) &&
  typeof (value as { transport?: { send?: unknown } }).transport?.send === "function";

/**
 * Imports the module the run was pointed at.
 *
 * The specifier is resolved to a `file:` URL first. A raw string handed to `import()` would also
 * accept `data:` URLs, which execute inline, and bare specifiers, which resolve out of
 * `node_modules` — running a user's config is arbitrary code execution by design, but a path the
 * user typed as a path should only ever be read as a path (D1-04).
 */
const loadRun = async (assignment: WorkerAssignment): Promise<WorkerRun> => {
  const moduleUrl = pathToFileURL(path.resolve(assignment.modulePath)).href;
  const imported: unknown = await import(moduleUrl);
  const factory = (imported as { default?: unknown }).default;
  if (typeof factory !== "function") {
    throw new TypeError(`${assignment.modulePath} must default-export a function`);
  }
  // Awaited, so an `async` factory works. A user who writes exactly what the docs describe, only
  // with an `async` keyword, should not be told their export "must return { scenarios, transport }".
  const run: unknown = await (factory as (state: unknown) => unknown)(assignment.setupState);
  if (!isRunShape(run)) {
    throw new TypeError(
      `${assignment.modulePath}'s default export must return { scenarios, transport }`,
    );
  }
  return run;
};

const main = async (assignment: WorkerAssignment): Promise<void> => {
  const { scenarios, transport } = await loadRun(assignment);
  const metrics = new MetricsRegistry();
  const shard = { index: assignment.shardIndex, count: assignment.shardCount };

  // Cumulative snapshots on a timer, for the live view. Each carries a fresh sequence, so a
  // message delayed in flight can never rewind the aggregate it arrives at.
  let sequence = 0;
  const ticker = setInterval(() => {
    sequence += 1;
    post({ kind: "snapshot", snapshot: metrics.toSnapshot(sequence) });
  }, assignment.snapshotIntervalMs);
  // The run is what keeps this thread alive; the ticker must not extend it by itself.
  ticker.unref();

  try {
    const outcome = await runDispatch<unknown>(
      {
        scenarios: shardScenarios(scenarios, shard),
        maxInFlight: assignment.maxInFlight,
        drainTimeoutMs: assignment.drainTimeoutMs,
      },
      { clock: systemClock, transport, metrics },
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

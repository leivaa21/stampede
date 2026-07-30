import type { RunProgress, ScenarioProgress } from "./run-summary.ts";

/**
 * What crosses the worker boundary, in both directions.
 *
 * Everything here is **data**. Functions cannot be structured-cloned, which is the constraint the
 * whole architecture is shaped around (D1-04): a worker cannot be handed a scenario's request
 * builder, so it is handed a *module specifier* and imports the work itself. `setupState` travels
 * the same way — plain data produced once on the main thread and given to every worker.
 */

/** What a worker's module must default-export. PR 5's config loader produces one of these. */
export type WorkerRunFactory = (setupState: unknown) => unknown;

export interface WorkerAssignment {
  /** Absolute path to the module the worker imports. Resolved to a `file:` URL on the other side. */
  readonly modulePath: string;
  readonly shardIndex: number;
  readonly shardCount: number;
  /** This worker's slice of the run's in-flight budget. */
  readonly maxInFlight: number;
  readonly drainTimeoutMs: number;
  /** How often to post a cumulative snapshot while the run is in progress. */
  readonly snapshotIntervalMs: number;
  /** Structured-cloneable state from `setup()`, identical for every worker. */
  readonly setupState: unknown;
}

/**
 * Worker → main.
 *
 * `progress` rides on `finished` rather than being derived on the main thread, because a shard's
 * elapsed time and its last-dispatch instant are things only that thread saw.
 */
export type WorkerMessage =
  | { readonly kind: "snapshot"; readonly snapshot: unknown }
  | { readonly kind: "finished"; readonly snapshot: unknown; readonly progress: RunProgress }
  | { readonly kind: "failed"; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseScenarioProgress = (value: unknown, at: string): ScenarioProgress => {
  if (!isRecord(value)) {
    throw new TypeError(`${at} must be an object`);
  }
  const { name, scheduledCount, requestedDurationMs, lastDispatchElapsedMs } = value;
  if (typeof name !== "string") {
    throw new TypeError(`${at}.name must be a string`);
  }
  if (typeof scheduledCount !== "number" || typeof requestedDurationMs !== "number") {
    throw new TypeError(`${at} is missing a count or duration`);
  }
  if (lastDispatchElapsedMs !== undefined && typeof lastDispatchElapsedMs !== "number") {
    throw new TypeError(`${at}.lastDispatchElapsedMs must be a number when present`);
  }
  return { name, scheduledCount, requestedDurationMs, lastDispatchElapsedMs };
};

/**
 * Narrows a message from a worker.
 *
 * A worker is our own code, so this is not a trust boundary in the security sense. It is a
 * *correctness* boundary: `parentPort.on("message")` hands over `unknown`, and an `as`-cast there
 * would let a protocol change on one side reach the aggregate as a silently wrong number on the
 * other. The metrics snapshot inside is narrowed separately, by `parseRegistrySnapshot`.
 */
export const parseWorkerMessage = (value: unknown): WorkerMessage => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("a worker message must be an object with a string `kind`");
  }
  switch (value.kind) {
    case "snapshot":
      return { kind: "snapshot", snapshot: value.snapshot };
    case "finished": {
      const { progress } = value;
      if (!isRecord(progress) || !Array.isArray(progress.scenarios)) {
        throw new TypeError("a finished message must carry run progress");
      }
      const { elapsedMs, maxObservedInFlight } = progress;
      if (typeof elapsedMs !== "number" || typeof maxObservedInFlight !== "number") {
        throw new TypeError("run progress is missing elapsedMs or maxObservedInFlight");
      }
      return {
        kind: "finished",
        snapshot: value.snapshot,
        progress: {
          elapsedMs,
          maxObservedInFlight,
          scenarios: progress.scenarios.map((scenario, index) =>
            parseScenarioProgress(scenario, `progress.scenarios[${String(index)}]`),
          ),
        },
      };
    }
    case "failed":
      return {
        kind: "failed",
        message: typeof value.message === "string" ? value.message : "a worker failed",
      };
    default:
      throw new TypeError(`unknown worker message kind "${value.kind}"`);
  }
};

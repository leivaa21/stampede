import type { RunProgress, ScenarioProgress } from "./run-summary.ts";

/**
 * What crosses the worker boundary, in both directions.
 *
 * Everything here is **data**. Functions cannot be structured-cloned, which is the constraint the
 * whole architecture is shaped around (D1-04): a worker cannot be handed a scenario's request
 * builder, so it is handed a *module specifier* and imports the work itself. `setupState` travels
 * the same way — plain data produced once on the main thread and given to every worker.
 */

export interface WorkerAssignment {
  /** Path to the config the worker imports; relative paths resolve against the process cwd. */
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
  | { readonly kind: "snapshot"; readonly snapshot: unknown; readonly progress: RunProgress }
  | { readonly kind: "finished"; readonly snapshot: unknown; readonly progress: RunProgress }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Deliberately *not* the same as `config/assert-shape.ts`'s `isRecord`, which also rejects arrays.
 *
 * There, an array slipping through means a config's `scenarios: [...]` loads fine and publishes a
 * report section called `0`. Here every field is narrowed by `kind` immediately below, so an array
 * fails the very next check — and this side parses messages from a worker we spawned rather than
 * input a user wrote. Two helpers with one name and different meanings is a copy-paste hazard, so:
 * if this ever grows a branch that trusts the shape without narrowing it, take the array guard too.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * `typeof x === "number"` admits `NaN` and `Infinity`, and a `NaN` reaching a frozen summary fails
 * every threshold comparison silently — `run-spec.ts` re-validates the same fields for exactly this
 * reason, and `metrics/narrow.ts` refuses them one field away in the same message. Shape checking
 * alone would only stop a protocol change that renamed something.
 */
const finiteAt = (value: unknown, at: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${at} must be a finite, non-negative number, got ${String(value)}`);
  }
  return value;
};

const countAt = (value: unknown, at: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${at} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
};

/**
 * The declared key spaces, narrowed like everything else that crosses the boundary.
 *
 * Narrowed rather than cast because the summary *drives its projection from this* — a malformed
 * shape here would not throw, it would silently publish a keyed counter with no keys, and the
 * `0`s a threshold reads would look like "none happened" rather than "nothing was parsed".
 */
const parseKeyedCounters = (
  value: unknown,
  at: string,
): Readonly<Record<string, readonly string[]>> => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError(`${at} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, keys]) => {
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
        throw new TypeError(`${at}.${name} must be an array of strings`);
      }
      return [name, keys as readonly string[]];
    }),
  );
};

const parseScenarioProgress = (value: unknown, at: string): ScenarioProgress => {
  if (!isRecord(value)) {
    throw new TypeError(`${at} must be an object`);
  }
  const { name, keyedCounters, scheduledCount, requestedDurationMs, lastDispatchElapsedMs } = value;
  if (typeof name !== "string") {
    throw new TypeError(`${at}.name must be a string`);
  }
  return {
    name,
    keyedCounters: parseKeyedCounters(keyedCounters, `${at}.keyedCounters`),
    scheduledCount: countAt(scheduledCount, `${at}.scheduledCount`),
    requestedDurationMs: finiteAt(requestedDurationMs, `${at}.requestedDurationMs`),
    lastDispatchElapsedMs:
      lastDispatchElapsedMs === undefined
        ? undefined
        : finiteAt(lastDispatchElapsedMs, `${at}.lastDispatchElapsedMs`),
  };
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
    case "finished": {
      const { progress } = value;
      if (!isRecord(progress) || !Array.isArray(progress.scenarios)) {
        // Both message kinds carry progress now. A mid-run merge that had metrics from every worker
        // but progress only from the finished ones reported a run whose dispatched count exceeded
        // its scheduled count — so progress travels on every message or the live view lies.
        throw new TypeError(`a ${value.kind} message must carry run progress`);
      }
      return {
        kind: value.kind,
        snapshot: value.snapshot,
        progress: {
          elapsedMs: finiteAt(progress.elapsedMs, "progress.elapsedMs"),
          maxObservedInFlight: countAt(
            progress.maxObservedInFlight,
            "progress.maxObservedInFlight",
          ),
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

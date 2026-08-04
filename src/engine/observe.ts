import type { ScenarioMetrics } from "../metrics/index.ts";
import {
  brokenCheckCounter,
  EngineMetric,
  keyedCounter,
  OTHER_KEY,
  RESERVED_METRIC_PREFIX,
} from "./metric-names.ts";
import type { ResponseRecorder, TransportResponse } from "./ports.ts";

/**
 * Running the user's checks and `onResponse` against one response.
 *
 * This is the file where user-written code executes on the hot path, inside a worker, once per
 * response — so its whole job is to let that code say what it has to say without letting it end the
 * run. D2-04: a check returning `false` is a **failure** and the point of the feature; a check that
 * **throws** is a *broken check*, counted separately and named at the end.
 *
 * The distinction is the same one D1-06 makes for threshold predicates, for the same reason: a bug
 * in an assertion must not be reported as the target violating an invariant, because that sends
 * someone hunting a race condition that was never there. And it must not abort a twenty-minute run
 * either — a load tester that dies mid-run publishes nothing.
 */

export interface ResponseObservers {
  /** Pre-flattened once per scenario: `Object.entries` per response allocates for a constant. */
  readonly checks: readonly (readonly [string, (response: TransportResponse) => boolean])[];
  /**
   * `=> unknown`, not `=> void`, deliberately: the public type in `ports.ts` says `void` to steer
   * the config author, but what arrives here is user code that has already been type-stripped, and
   * this file's whole job is to deal with whatever it actually returns.
   */
  readonly onResponse:
    ((response: TransportResponse, record: ResponseRecorder) => unknown) | undefined;
  /** Built once per scenario — the closures are pure functions of the scenario's metrics. */
  readonly recorder: ResponseRecorder;
}

/**
 * A promise reaching here is a callback the user made `async`.
 *
 * TypeScript assigns `() => Promise<void>` to a `() => void` parameter without complaint, so
 * nothing upstream stops it — and an unhandled rejection from a worker takes the whole run down,
 * publishing nothing. `async (r) => JSON.parse(r.text) !== null` is a completely natural thing to
 * write, so this is a likely mistake rather than an exotic one: the promise is neutralised here and
 * the observation counted broken, which is what every other broken observation gets.
 */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

/** @returns whether a promise was swallowed, so the caller can count the observation broken. */
const neutralise = (value: unknown): boolean => {
  if (!isThenable(value)) {
    return false;
  }
  void Promise.resolve(value).catch(() => undefined);
  return true;
};

/**
 * Builds the recorder a scenario's `onResponse` writes through. One per scenario, not per response.
 *
 * Refuses the engine's own namespace. The user's counters and the engine's live in the same map, so
 * `record.count("stampede.dropped", 100)` would otherwise make a run report four hundred dropped
 * requests that never happened — in a tool whose whole pitch is that its numbers are honest.
 * Data-derived, so it is refused and counted rather than thrown (`metrics/validate.ts`'s rule).
 */
export const recorderFor = (
  metrics: ScenarioMetrics,
  /** Declared key spaces, by counter name. Every key here already has a reserved slot. */
  keyed: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ResponseRecorder => ({
  count: (name, by = 1) => {
    if (name.startsWith(RESERVED_METRIC_PREFIX)) {
      metrics.counters.inc(EngineMetric.reservedNameRefusals);
      return;
    }
    metrics.counters.inc(name, by);
  },
  countKeyed: (name, key, by = 1) => {
    const keys = keyed.get(name);
    if (keys === undefined) {
      // A counter the scenario never declared is a claim the config did not make, and there is no
      // bounded slot to put it in — so it is refused and counted, not invented.
      metrics.counters.inc(EngineMetric.undeclaredCounters);
      return;
    }
    // An undeclared *key* is the ordinary case this feature exists for: the key came from a
    // response, the config could not enumerate every value, and `other` is where it belongs.
    metrics.counters.inc(keyedCounter(name, keys.has(key) ? key : OTHER_KEY), by);
  },
  recordMs: (name, valueMs) => {
    if (name.startsWith(RESERVED_METRIC_PREFIX)) {
      metrics.counters.inc(EngineMetric.reservedNameRefusals);
      return;
    }
    metrics.trend(name).recordMs(valueMs);
  },
});

/** Records a check as broken: counted against its own name, and against the scenario's total. */
const recordBroken = (metrics: ScenarioMetrics, name: string): void => {
  metrics.counters.inc(EngineMetric.brokenChecks);
  // Per name, so a report can say *which* claim is broken. Without this a throwing check was
  // written into `failed`, and the checks table read "**FAIL** | oneWinnerOrConflict | 0 | 500" —
  // a report accusing the target of double-selling 500 seats because a predicate had a typo.
  //
  // The per-name counter can be refused if the registry's counter budget is full; the total above
  // never is, so a full budget costs the attribution, never the verdict.
  metrics.counters.inc(brokenCheckCounter(name));
};

export const observeResponse = (
  metrics: ScenarioMetrics,
  observers: ResponseObservers,
  response: TransportResponse,
): void => {
  for (const [name, predicate] of observers.checks) {
    try {
      const held: unknown = predicate(response);
      if (typeof held === "boolean") {
        metrics.checks.record(name, held);
      } else {
        // Node strips the user's types without checking them, so nothing guarantees a boolean —
        // and `(r) => { r.status === 200 }`, braces instead of parens, returns `undefined`.
        void neutralise(held);
        recordBroken(metrics, name);
      }
    } catch {
      // The error itself is deliberately not kept. It would be a different string per response for
      // a check that throws on every one of them, and the count plus the check's *name* is what a
      // reader needs — not a run's worth of identical stacks.
      recordBroken(metrics, name);
    }
  }

  if (observers.onResponse !== undefined) {
    try {
      const returned: unknown = observers.onResponse(response, observers.recorder);
      // Counted, not merely survived. `load.ts` refuses a literal `async` callback, but a plain
      // arrow that *returns* a promise — `(r, record) => fetch(logUrl).then(() => record.count(…))`
      // — passes every gate, and its counts land after the run has published. Swallowing that
      // quietly meant a run reporting zero of a counter the config incremented on every response,
      // with nothing on the page saying so.
      if (neutralise(returned)) {
        metrics.counters.inc(EngineMetric.brokenObservers);
      }
    } catch {
      metrics.counters.inc(EngineMetric.brokenObservers);
    }
  }
};

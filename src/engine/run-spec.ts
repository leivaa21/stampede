import { keyedCounter, OTHER_KEY, RESERVED_METRIC_PREFIX } from "./metric-names.ts";
import type { ResponseCheck, ResponseRecorder, TransportResponse } from "./ports.ts";
import { assertShard, type Shard } from "./schedule-split.ts";
import type { ScheduledScenario } from "./schedule.ts";
import { assertCount, assertDurationMs, assertPositiveCount } from "./validate.ts";

/**
 * A `request()` that mutated the frozen setup state (D25-02), carried as a type rather than a
 * message.
 *
 * Declared here, in `engine/`, because the dispatcher is what acts on it — counting an impure
 * builder apart from one that merely threw. `config/to-run.ts` constructs it and imports *up*; the
 * reverse would put the config loader on the hot dispatch path a stranger traces.
 *
 * A type rather than a string match, because this repo has been bitten twice by re-deriving that
 * distinction from a message.
 */
/**
 * Thrown where the freeze is, which is `worker-entry.ts` — so library users meet it through
 * `runFromConfig`, and the low-level `scenariosFrom` + `runDispatch` path deliberately does not
 * freeze and therefore never throws it. It is exported because the dispatcher *branches* on the
 * type to keep impure builds out of `requestErrors`, and a class that decides a published number
 * should be nameable by the code reading that number.
 */
export class ImpureRequestError extends Error {}

/** How long the run keeps waiting for responses after its last dispatch went out. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/**
 * A scenario: a name, when it dispatches, and what it sends.
 *
 * `requestFor` takes the dispatch ordinal so a scenario can vary per request — "N buyers, N
 * distinct seats" (D2-02). The ordinal it receives is **global to the run**, not local to a shard;
 * see `RunSpec.shard`.
 */
export interface Scenario<TRequest> extends ScheduledScenario {
  readonly requestFor: (ordinal: number) => TRequest;
  /** Named predicates over each response — see `config/types.ts` and D2-04. */
  readonly checks?: Readonly<Record<string, ResponseCheck>>;
  /**
   * Declared key spaces for keyed counters, by counter name (D25-01).
   *
   * Normalised to plain key lists here — the config's `{ keys: [...] }` wrapper exists so the
   * declaration has somewhere to grow, and the engine does not need that shape.
   */
  readonly keyedCounters?: Readonly<Record<string, readonly string[]>>;
  /** Runs once per response, for counters and trends a check cannot express. */
  readonly onResponse?: (response: TransportResponse, record: ResponseRecorder) => void;
}

export interface RunSpec<TRequest> {
  readonly scenarios: readonly Scenario<TRequest>[];
  /**
   * Requests allowed outstanding at once, across the whole run.
   *
   * Mandatory, because open-loop dispatch against a target that has stopped answering is unbounded
   * memory (D1-01): the schedule keeps producing instants whether or not anything comes back.
   * Breaches are dropped **and counted** — a run with drops has an achieved rate below its
   * requested one, and the report has to be able to say so.
   *
   * The cap is a **run-level** resource, and when it binds on requests sharing an instant the
   * scenarios earlier in the list take the slots: first-listed wins, later ones are dropped. That
   * is deterministic and fully reported per scenario, but it is winner-takes-all rather than a fair
   * share — worth knowing when sizing this for a multi-scenario burst.
   */
  readonly maxInFlight: number;
  /**
   * How long to keep waiting for outstanding responses once the schedule is exhausted. Defaults to
   * {@link DEFAULT_DRAIN_TIMEOUT_MS}. Whatever is still outstanding at the deadline is counted as
   * abandoned and left uncounted in the latency percentiles.
   */
  readonly drainTimeoutMs?: number;
  /**
   * Which slice of the run this dispatch loop is, so ordinals can be made global.
   *
   * `mergedSchedule` numbers dispatches from 0 within whatever it is given, so four workers would
   * each build request 0, 1, 2 — and "N buyers, N distinct seats" would quietly become four buyers
   * per seat, the exact bug contract run 2 exists to detect. The stride split *is* the mapping
   * `shardIndex + localOrdinal * shardCount`, so the recovery is exact by construction.
   *
   * Defaults to the whole run being one shard, which is what a single-threaded `runDispatch` is.
   */
  readonly shard?: Shard;
}

/**
 * Validates a run before a single request goes out.
 *
 * Duplicate scenario names are the interesting one: the metrics registry namespaces by name, so
 * two scenarios called `reads` would silently merge into one set of percentiles — a report with a
 * section that is quietly the average of two different things. Cheap to catch here, invisible
 * afterwards.
 */
export const assertRunSpec = <TRequest>(spec: RunSpec<TRequest>): void => {
  if (spec.scenarios.length === 0) {
    throw new RangeError("A run must hold at least one scenario");
  }
  assertPositiveCount(spec.maxInFlight, "maxInFlight");
  if (spec.drainTimeoutMs !== undefined) {
    assertDurationMs(spec.drainTimeoutMs, "drainTimeoutMs");
  }

  if (spec.shard !== undefined) {
    // A public field on a public type: `{ index: 0, count: 0 }` makes every ordinal 0, so every
    // buyer gets seat 0 silently for the whole run — the exact bug D2-02 exists to detect,
    // reintroduced through the door D2-02 opened.
    assertShard(spec.shard);
  }

  for (const scenario of spec.scenarios) {
    // Refused once, here, rather than in each consumer. Three separate readers act on a declared
    // key space — the reservation, the recorder, and the summary's projection — and guarding them
    // one at a time is how a keyed counter named `stampede` came to be skipped by the reservation
    // and still read back by the projection, publishing the engine's own drop and response counts
    // as a user's table.
    //
    // **This door refuses only what would let a caller read stampede's own numbers.** The rest of
    // the declaration rules — slot collisions between two declarations, key-space budgets, name
    // lengths — belong to `config/assert-shape.ts`, because they are about a config being sensible
    // rather than about the engine being safe. A programmatic caller can still declare two
    // counters that share a slot; it publishes its own increments twice and nothing else.
    for (const counter of Object.keys(scenario.keyedCounters ?? {})) {
      if (keyedCounter(counter, OTHER_KEY).startsWith(RESERVED_METRIC_PREFIX)) {
        throw new RangeError(
          `Scenario "${scenario.name}" declares a keyed counter "${counter}" that would store into ` +
            `"${RESERVED_METRIC_PREFIX}", which is reserved for stampede's own metrics`,
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const { name, profile } of spec.scenarios) {
    if (seen.has(name)) {
      throw new RangeError(`Scenario names must be unique within a run; "${name}" is repeated`);
    }
    seen.add(name);

    // `constantRate`/`ramp`/`burst` validate their own inputs, but `ArrivalProfile` is an exported
    // interface: a programmatic caller can hand over a hand-built `{ count, durationMs, instants }`
    // that never went through them. Re-checking here keeps `NaN` and `Infinity` out of
    // `scheduledCount` and `requestedRatePerSecond`, which are published, frozen, and read by
    // threshold predicates — a `NaN` there fails every comparison silently.
    assertCount(profile.count, `${name}'s profile count`);
    assertDurationMs(profile.durationMs, `${name}'s profile duration`);
  }
};

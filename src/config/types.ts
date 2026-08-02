import type { ArrivalProfile } from "../engine/arrival-profiles.ts";
import type { HttpRequestSpec } from "../engine/http-transport.ts";
import type { ResponseCheck, ResponseRecorder, TransportResponse } from "../engine/ports.ts";
import type { RunSummary } from "../engine/run-summary.ts";

/**
 * The scenario config — which the non-goals call **the DSL**.
 *
 * There is no scripting language here on purpose: a threshold is a typed predicate, a profile is a
 * function call, and a request is an object. All of it is autocompleted and type-checked by the
 * editor the user already has, and none of it needs a parser this project would then have to own.
 */

/** A run's whole state from `setup()`, as every virtual user sees it. */
export interface ScenarioConfig<TSetup> {
  /**
   * When this scenario dispatches.
   *
   * Evaluated when the module is imported — **before `setup()` runs** — so it cannot read the setup
   * state. `request` can, because it is a function called afterwards. A profile whose rate depends
   * on something discovered at setup time is not expressible today.
   */
  readonly profile: ArrivalProfile;
  /**
   * Builds the request this scenario sends, once per dispatch.
   *
   * Built rather than written literally so a scenario can use what `setup()` created — the show id
   * for open-ticket's namesake run, an auth token, a seeded row.
   *
   * `ordinal` is the request's position **in the whole run**, from 0, and is what makes "N buyers,
   * N distinct seats" expressible: `seatIds: [seats[ordinal % seats.length]]`. It is global rather
   * than per-worker, so four threads never build the same request four times (D2-02). Ignore it and
   * every buyer sends the same thing, which is the namesake run.
   *
   * Keep it cheap: it runs on the dispatch path, once per request, and time spent here is time the
   * generator is not dispatching. If it throws, that request is counted as a build failure and the
   * run continues — reported as `not built`, never as the target refusing.
   *
   * **It must be a pure function of `(setupState, ordinal)`.** Every worker gets its own structured
   * clone of the setup state, so a builder that consumes shared state — `state.seats.pop()`, an
   * incrementing nonce — hands four threads the same four values rather than sixteen distinct ones.
   * The ordinal exists precisely so variation can be derived rather than accumulated. stampede also
   * calls this once at ordinal 0 per worker before the run starts, to fail a malformed request at
   * startup instead of twenty minutes in, which an impure builder would notice.
   */
  readonly request: (setupState: TSetup, ordinal: number) => HttpRequestSpec;
  /**
   * Named predicates over a response, counted pass/fail and reported as a row.
   *
   * This is what makes stampede an assertion tool rather than a benchmarker: "exactly one 201
   * among 500 racers" is a claim about a *run*, and it starts here, one response at a time.
   *
   * The **name** is what the report and a failing CI job print, so name the claim rather than the
   * expression — `oneWinnerOrConflict` beats `status2xxOr409`.
   *
   * A predicate returning `false` is a failure and the point of the feature. A predicate that
   * *throws* is a **broken check** (D2-04): counted separately, the run continues, and the run
   * fails at the end with the check named — a bug in an assertion must not be reported as the
   * target violating an invariant.
   */
  readonly checks?: Readonly<Record<string, ResponseCheck>>;
  /**
   * Runs once per response, for counters and trends a check cannot express.
   *
   * A check answers yes or no. This is for everything else: counting how many buyers got a 201,
   * recording the `behindMs` a projection reported, tallying an optimistic-retry header. Runs on
   * the worker's hot path, so keep it cheap — and like a check, a throw here is counted and named
   * rather than allowed to end the run.
   */
  readonly onResponse?: (response: TransportResponse, record: ResponseRecorder) => void;
}

/**
 * A named claim about the whole run.
 *
 * The name is not decoration: it is what the report prints and what a CI failure says out loud, so
 * "exactly one buyer wins" beats `counters.reserved201 == 1` at three in the morning.
 */
export interface Threshold {
  readonly name: string;
  readonly assert: (summary: RunSummary) => boolean;
}

export interface StampedeConfig<TSetup = undefined> {
  /**
   * Runs **once, on the main thread**, before any load.
   *
   * Its return value is handed to every virtual user, so it must be structured-cloneable data —
   * functions cannot cross a worker boundary (D1-04). Create the show here, not a client for it.
   */
  readonly setup?: () => TSetup | Promise<TSetup>;
  /**
   * Runs **once, on the main thread**, after the storm and after the drain.
   *
   * This is where an invariant gets *proven* rather than merely observed: re-read the seat map and
   * assert exactly one seat sold. Throwing here fails the run with exit 1, like a violated
   * threshold — because that is what it is.
   *
   * **An assertion hook, not a cleanup hook.** It does not run when the run itself failed: a
   * teardown written to assert would otherwise report "the invariant did not hold" about a storm
   * that never happened, and mask the real reason. Anything that must be cleaned up regardless
   * belongs in the harness around `stampede`, not here.
   */
  readonly teardown?: (setupState: TSetup) => void | Promise<void>;
  /** At least one. Several run concurrently, each with its own metrics (D1-05). */
  readonly scenarios: Readonly<Record<string, ScenarioConfig<TSetup>>>;
  readonly thresholds?: readonly Threshold[];
  /** Defaults to one per available core, minus one, floored at 1. */
  readonly workers?: number;
  /** Requests allowed outstanding across the whole run. Mandatory in spirit; defaulted in practice. */
  readonly maxInFlight?: number;
  readonly drainTimeoutMs?: number;
}

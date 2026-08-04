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
   * Counters whose key space is declared up front, for the dimensions a plain counter cannot hold.
   *
   * A counter per endpoint path or per status class is a reasonable thing to want, and doing it
   * with `record.count(path)` is a cardinality bomb: the per-scenario cap is 512 names, and a run
   * that exceeds it fails telling you to use fewer. Declaring the keys makes the space bounded
   * before a single request goes out.
   *
   * ```ts
   * counters: { byStatus: { keys: ["2xx", "4xx", "5xx"] } },
   * onResponse: (res, record) => record.countKeyed("byStatus", bucketOf(res.status)),
   * ```
   *
   * **Declared here, read back as `keyedCounters` on the summary** — `s.scenarios[0].counters` is
   * the map of plain counters you never declared, and a threshold looking for `byStatus` there
   * finds `undefined`.
   *
   * Every declared key gets a slot reserved before the run starts, plus an implicit `other` for
   * keys that were not declared — so nothing is ever dropped, and a non-zero `other` tells you the
   * key space is wrong. Declared rather than inferred (D25-01): a top-N sketch would need no
   * advance knowledge and would merge approximately and order-dependently, which is the one
   * property `metrics/` does not trade away.
   */
  readonly counters?: Readonly<Record<string, { readonly keys: readonly string[] }>>;
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
   * **An assertion hook, not a cleanup hook.** It does not run when the load could not be generated
   * at all — a config that would not load, a `setup()` that threw, a scenario that recorded no
   * responses — because a teardown written to assert would report "the invariant did not hold"
   * about a storm that never happened, and mask the real reason.
   *
   * It *does* run when the storm happened and something else about the run was broken: a check that
   * threw, a metric name that was refused. Those exit 2, but the requests were real and so is
   * whatever they did to the target, so the invariant is still worth asking about — and its answer
   * is reported alongside the other reasons rather than instead of them.
   *
   * Anything that must be cleaned up regardless belongs in the harness around `stampede`, not here.
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

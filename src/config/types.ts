import type { ArrivalProfile } from "../engine/arrival-profiles.ts";
import type { HttpRequestSpec } from "../engine/http-transport.ts";
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
   * The request this scenario sends, built once from the setup state.
   *
   * Built rather than written literally so a scenario can use what `setup()` created — the show id
   * for open-ticket's namesake run, an auth token, a seeded row. Per-*request* variation (a
   * different seat per buyer) needs the engine to carry a dispatch ordinal across shards and is a
   * later milestone; `schedule-split.ts` documents how that ordinal is recovered when it lands.
   */
  readonly request: (setupState: TSetup) => HttpRequestSpec;
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

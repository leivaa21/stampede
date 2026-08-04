import type { RunSummary } from "../engine/run-summary.ts";
import type { Threshold } from "../config/types.ts";

/**
 * Deciding whether a run passed, and saying which claim broke.
 *
 * D1-06: a threshold is a named predicate, and the **name** is what a failing CI job prints. That is
 * the whole reason it is not a string mini-language — "exactly one buyer wins" is worth more at
 * three in the morning than `counters.reserved201 == 1`.
 */

export interface ThresholdResult {
  readonly name: string;
  readonly held: boolean;
  /** Set when the predicate itself threw, rather than returning false. */
  readonly error: string | undefined;
}

export interface Verdict {
  readonly results: readonly ThresholdResult[];
  readonly violated: readonly string[];
  /** Thresholds whose predicate threw — a broken claim, not a broken system. */
  readonly broken: readonly string[];
}

/**
 * Points at the knob the counts actually implicate.
 *
 * "check the target is reachable" is one hypothesis, and printing it while the same sentence says
 * `10 dropped` sends the user to the wrong place — that is `maxInFlight`, not the network.
 */
const IMPURE_REMEDY =
  "`request()` mutated the setup state, which is guarded — it must be a pure function of (state, ordinal). Derive from the ordinal instead: `seats[ordinal % seats.length]`.";

const REQUEST_THREW_REMEDY = "the requests threw while being built; fix `request()` in the config.";

const adviceFor = (scenario: RunSummary["scenarios"][number]): string => {
  // First, because it is the only one of these where the *config* is at fault: nothing was sent, so
  // no advice about the target or its cap can be right. "check the target is reachable" for a
  // `request()` that threw on every ordinal sends someone to inspect a server that was never asked.
  // The two build failures are judged as a *family*: compared separately against the schedule, a
  // run with 5 impure and 5 thrown satisfied neither and fell through to "check the target is
  // reachable" — pointing at a server that had been asked once out of eleven.
  //
  // It has to out-weigh every branch it can steal from, not just the dispatches. Under a binding
  // in-flight cap `dispatchedCount` sits at `maxInFlight` by construction, so `unbuilt >=
  // dispatched` alone claimed the builder for a run of 1000 with 970 dropped and 20 thrown — a
  // slow target with a tight cap, told to go fix `request()`.
  const unbuilt = scenario.impureRequestCount + scenario.requestErrorCount;
  if (unbuilt > 0 && unbuilt >= scenario.dispatchedCount && unbuilt >= scenario.droppedCount) {
    return scenario.impureRequestCount > 0 ? IMPURE_REMEDY : REQUEST_THREW_REMEDY;
  }
  if (scenario.droppedCount >= scenario.dispatchedCount && scenario.droppedCount > 0) {
    return "almost everything was refused by the in-flight cap; raise `maxInFlight`.";
  }
  if (scenario.abandonedCount > 0 && scenario.errorCount === 0) {
    return "the requests went out but nothing came back in time; raise `drainTimeoutMs`.";
  }
  return "check the target is reachable.";
};

/**
 * The remedy, whichever cause won.
 *
 * `findUnmeasuredScenario` returns before `findImpureRequests` ever runs, so on that path this is
 * the only route the purity contract has to the reader — and the shortfall line they are looking at
 * says `1 not built (impure request())`, a phrase that does not define itself. So it is appended
 * even when something else is the dominant cause, rather than being lost to a branch it did not win.
 */
const adviceWithPurity = (scenario: RunSummary["scenarios"][number]): string => {
  const advice = adviceFor(scenario);
  return scenario.impureRequestCount === 0 || advice === IMPURE_REMEDY
    ? advice
    : `${advice} Separately, ${scenario.impureRequestCount === 1 ? "1 request" : `${String(scenario.impureRequestCount)} requests`} could not be built at all: ${IMPURE_REMEDY}`;
};

/**
 * A scenario whose numbers are *incomplete*, rather than bad.
 *
 * Cardinality caps refuse recordings rather than throwing, which is right — a run must not die at
 * minute nineteen because a config asked for one name too many. But a threshold reading a counter
 * that was refused reads a confident `0`, and reports a violation the target never caused. So the
 * refusals fail the run on the run-failed code, naming the cap.
 */
export const findRefusedRecordings = (summary: RunSummary): string | undefined => {
  for (const scenario of summary.scenarios) {
    if (scenario.refusedRecordings > 0) {
      return (
        `scenario "${scenario.name}" refused ${String(scenario.refusedRecordings)} recordings — ` +
        `it asked for more distinct metric names than a per-scenario cap allows (512 counters, ` +
        `512 checks, 32 distributions), or for a name over 120 characters. ` +
        `The values that were recorded are real, but some are missing entirely, so a threshold ` +
        `reading one of them would read 0 rather than the truth. Use fewer distinct names — ` +
        `a counter or a trend per seat is a cardinality bomb; one per outcome is not.`
      );
    }
  }
  return undefined;
};

/**
 * A scenario whose `request()` mutated the guarded setup state (D25-02).
 *
 * Its own finder rather than a term of `brokenObservations`, which documents itself as checks and
 * `onResponse` — routing it there told a config with neither that "a check or onResponse threw",
 * two lines under a shortfall correctly naming `request()`. That is D2-04's own failure mode (a
 * report accusing the reader of something they did not do) one door over, and it also put one
 * event in two accounting families: `impure` is a term of the dispatch identity *and* was a term
 * of an observation count, for a request that was never made.
 */
export const findImpureRequests = (summary: RunSummary): string | undefined => {
  for (const scenario of summary.scenarios) {
    if (scenario.impureRequestCount > 0) {
      return (
        `scenario "${scenario.name}" could not build ${String(scenario.impureRequestCount)} requests ` +
        `because \`request()\` mutated the setup state, which is guarded — it must be a pure ` +
        `function of (state, ordinal). Every worker holds its own clone, so consuming shared state ` +
        `hands each thread the same values instead of distinct ones. Derive from the ordinal ` +
        `instead: \`seats[ordinal % seats.length]\`.`
      );
    }
  }
  return undefined;
};

/**
 * A scenario whose *assertions* are broken, rather than whose target is.
 *
 * D2-04: a check that threw or returned a non-boolean is a bug in the claim, so the run fails —
 * but on the run-failed code, with the assertion named. Reporting it as a violated threshold would
 * blame the target for a typo, which is the confusion the exit-code contract exists to prevent.
 */
export const findBrokenObservations = (summary: RunSummary): string | undefined => {
  for (const scenario of summary.scenarios) {
    if (scenario.brokenObservations > 0) {
      return (
        `scenario "${scenario.name}" had ${String(scenario.brokenObservations)} broken observations — ` +
        `a check or onResponse threw, returned something other than true/false, or named a ` +
        `metric the scenario cannot write: stampede's own namespace, a \`countKeyed\` on a ` +
        `counter that was never declared, or a \`count\` inside a declared counter's namespace. ` +
        `The run's numbers are real, but at least one of its claims is not.`
      );
    }
  }
  return undefined;
};

/**
 * A scenario that recorded nothing fails the **run**, before any threshold is evaluated.
 *
 * D1-02 makes an empty histogram `undefined` rather than `0`, because zero latency is a lie about a
 * run that measured nothing. Rejecting the empty run here is what lets the threshold-facing summary
 * expose plain numbers — otherwise the obvious way to satisfy the type-checker would be
 * `(s.p99 ?? 0) < 250`, and a scenario that never ran would *pass* its threshold. That is precisely
 * the lie the `undefined` was chosen to prevent, reintroduced by the ergonomics of preventing it.
 *
 * Exit 2 rather than 1 is the honest classification: a scenario that issued requests and got nothing
 * back is broken, not violated.
 */
export const findUnmeasuredScenario = (summary: RunSummary): string | undefined => {
  for (const scenario of summary.scenarios) {
    if (scenario.scheduledCount > 0 && scenario.responseCount === 0) {
      return (
        `scenario "${scenario.name}" recorded no responses at all ` +
        `(${String(scenario.dispatchedCount)} dispatched, ${String(scenario.errorCount)} failed, ` +
        `${String(scenario.droppedCount)} dropped, ${String(scenario.requestErrorCount)} not built, ` +
        `${String(scenario.impureRequestCount)} impure, ` +
        `${String(scenario.abandonedCount)} abandoned). ` +
        `There is nothing to publish a percentile from — ${adviceWithPurity(scenario)}`
      );
    }
  }
  return undefined;
};

export const evaluateThresholds = (
  thresholds: readonly Threshold[],
  summary: RunSummary,
): Verdict => {
  const results = thresholds.map((threshold): ThresholdResult => {
    try {
      const held: unknown = threshold.assert(summary);
      // Node strips the user's types without checking them, so nothing at runtime guarantees a
      // boolean — and the commonest slip in JavaScript, braces instead of an expression body,
      // returns `undefined`. Reporting that as a violation would exit 1, telling CI the *target*
      // broke an invariant, for a typo in the config.
      if (typeof held !== "boolean") {
        return {
          name: threshold.name,
          held: false,
          error: `the predicate returned ${held === undefined ? "undefined" : typeof held}, not true or false — did you write \`{ … }\` where you meant \`( … )\`?`,
        };
      }
      return { name: threshold.name, held, error: undefined };
    } catch (error: unknown) {
      // A predicate that throws is a broken *claim* — a typo reaching into a scenario that does not
      // exist, most likely. Reporting it as a violation would blame the target for the config's
      // mistake, so it is kept separate and lands on the run-failed exit code.
      return {
        name: threshold.name,
        held: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return {
    results,
    violated: results.filter((r) => !r.held && r.error === undefined).map((r) => r.name),
    broken: results.filter((r) => r.error !== undefined).map((r) => r.name),
  };
};

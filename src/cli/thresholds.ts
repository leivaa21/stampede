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
/**
 * Points at the knob the counts actually implicate.
 *
 * "check the target is reachable" is one hypothesis, and printing it while the same sentence says
 * `10 dropped` sends the user to the wrong place — that is `maxInFlight`, not the network.
 */
const adviceFor = (scenario: RunSummary["scenarios"][number]): string => {
  // First, because it is the only one of these where the *config* is at fault: nothing was sent, so
  // no advice about the target or its cap can be right. "check the target is reachable" for a
  // `request()` that threw on every ordinal sends someone to inspect a server that was never asked.
  if (scenario.requestErrorCount >= scenario.scheduledCount && scenario.requestErrorCount > 0) {
    return "every request threw while being built; fix `request()` in the config.";
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
        `a check or onResponse threw, or a check returned something other than true/false. ` +
        `The run's numbers are real, but at least one of its claims is not.`
      );
    }
  }
  return undefined;
};

export const findUnmeasuredScenario = (summary: RunSummary): string | undefined => {
  for (const scenario of summary.scenarios) {
    if (scenario.scheduledCount > 0 && scenario.responseCount === 0) {
      return (
        `scenario "${scenario.name}" recorded no responses at all ` +
        `(${String(scenario.dispatchedCount)} dispatched, ${String(scenario.errorCount)} failed, ` +
        `${String(scenario.droppedCount)} dropped, ${String(scenario.requestErrorCount)} not built, ` +
        `${String(scenario.abandonedCount)} abandoned). ` +
        `There is nothing to publish a percentile from — ${adviceFor(scenario)}`
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

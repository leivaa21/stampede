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
export const findUnmeasuredScenario = (summary: RunSummary): string | undefined => {
  for (const scenario of summary.scenarios) {
    if (scenario.scheduledCount > 0 && scenario.responseCount === 0) {
      return (
        `scenario "${scenario.name}" recorded no responses at all ` +
        `(${String(scenario.dispatchedCount)} dispatched, ${String(scenario.errorCount)} failed, ` +
        `${String(scenario.droppedCount)} dropped, ${String(scenario.abandonedCount)} abandoned). ` +
        `There is nothing to publish a percentile from — check the target is reachable.`
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
      return { name: threshold.name, held: threshold.assert(summary), error: undefined };
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

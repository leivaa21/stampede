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

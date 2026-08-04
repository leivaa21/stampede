import type { ScenarioRunSummary } from "../engine/run-summary.ts";

/**
 * The one place that phrases "what did not happen" for every surface.
 *
 * Three surfaces render this list — the CLI summary, the markdown report, and the live dashboard —
 * and before this they each built it inline. The same 9 requests read `9 not built (request()
 * mutated the setup state)`, `9 not built (impure request())` and `9 impure request()` depending on
 * where you looked, which is three vocabularies for one number in a tool whose entire argument is
 * that its numbers are trustworthy.
 *
 * Sharing the phrasing is the smaller half. The larger half is that a *new* term — `impure` was
 * one, and M3's streaming will bring another — now reaches all three surfaces by construction
 * instead of by remembering three files. The dashboard was already missing `abandoned`.
 */

/**
 * Every non-zero way a scheduled instant failed to become a measured response, in schedule order:
 * refused before dispatch, never built, built and sent but failed, sent and never answered.
 *
 * Empty for a clean run, because a summary that prints `shortfall none` teaches the reader to skip
 * the line on the run where it matters.
 */
export const shortfallParts = (scenario: ScenarioRunSummary): readonly string[] =>
  [
    scenario.droppedCount > 0 ? `${String(scenario.droppedCount)} dropped` : undefined,
    // Two causes, never merged into one "not built": one is a `request()` that threw and the other
    // is a `request()` that mutated the frozen setup state (D25-02), and the remedies have nothing
    // in common. The parenthetical is the whole value of the term.
    scenario.requestErrorCount > 0
      ? `${String(scenario.requestErrorCount)} not built (request() threw)`
      : undefined,
    scenario.impureRequestCount > 0
      ? `${String(scenario.impureRequestCount)} not built (impure request())`
      : undefined,
    scenario.errorCount > 0 ? `${String(scenario.errorCount)} failed` : undefined,
    // Zero until the drain ends, so on the dashboard this term simply does not appear mid-run.
    scenario.abandonedCount > 0 ? `${String(scenario.abandonedCount)} abandoned` : undefined,
  ].filter((part): part is string => part !== undefined);

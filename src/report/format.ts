/**
 * Formatting shared by the terminal renderer and the markdown report.
 *
 * Extracted because the rounding rule is honesty-critical and was living in two places: the report
 * said "exactly as the terminal renderer does", which was true only by copy-paste, and a fix to one
 * would have missed the other. One home, one comment, one thing to get right.
 */

export const ms = (value: number | undefined): string =>
  value === undefined ? "—" : `${value.toFixed(1)}ms`;

/** Sub-second runs in ms: "took 0.0s" next to a p99 of 37ms reads as "took no time". */
export const duration = (elapsedMs: number): string =>
  elapsedMs < 1_000 ? `${String(Math.round(elapsedMs))}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;

/**
 * A rate, rounded in the direction that cannot make a shortfall disappear.
 *
 * `Math.round` on both sides turned "2/s requested, 1.6/s achieved" — a 20 % shortfall — into
 * `2/s · 2/s`, and a scenario achieving 0.4/s into a flat `0/s`. So the requested side rounds up,
 * the achieved side rounds down, and anything under 10/s keeps decimals rather than collapsing.
 */
export const rate = (value: number | undefined, direction: "requested" | "achieved"): string => {
  if (value === undefined) {
    return "—";
  }
  const round = direction === "achieved" ? Math.floor : Math.ceil;
  if (value < 10) {
    return `${String(round(value * 100) / 100)}/s`;
  }
  return `${round(value).toLocaleString("en-US")}/s`;
};

/**
 * Makes a user-supplied string safe to put in a markdown table cell.
 *
 * Scenario names, threshold names and predicate error messages are all free text, and they go into
 * a structured format. Unescaped, a name containing `|` makes GitHub drop everything after it — a
 * *silently truncated published claim* — and a multi-line message (every `node:assert` failure is
 * one) ends the table entirely, taking every row below it with it.
 */
export const cell = (text: string): string =>
  text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

/** The same, for a value going inside an inline code span, where a backtick would break out. */
export const codeSpan = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

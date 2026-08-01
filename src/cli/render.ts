import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import type { Verdict } from "./thresholds.ts";

/**
 * What a finished run says on a terminal.
 *
 * Plain text, no colour, no cursor tricks: this is the output a CI log keeps, and the live
 * dashboard is a separate consumer of the same summary (D1-07). Every number that could flatter the
 * target is printed next to the one that contradicts it — requested beside achieved, dispatched
 * beside dropped — because a reader should not have to know which field to be suspicious of.
 *
 * Rounding happens here and only here: `RunSummary` keeps full precision because threshold
 * predicates read it. Every rounding in this file goes **away** from flattering the target.
 */

const ms = (value: number | undefined): string =>
  value === undefined ? "—" : `${value.toFixed(1)}ms`;

/**
 * A rate, rounded in the direction that cannot make a shortfall disappear.
 *
 * `Math.round` on both sides turned "2/s requested, 1.6/s achieved" — a 20 % shortfall — into
 * `2/s · 2/s`, and a scenario achieving 0.4/s into a flat `0/s`. So the requested side rounds up,
 * the achieved side rounds down, and anything under 10/s keeps a decimal rather than collapsing.
 */
const rate = (value: number | undefined, direction: "requested" | "achieved"): string => {
  if (value === undefined) {
    return "—";
  }
  if (value < 10) {
    // Two decimals below 10/s: a sub-1/s rate printing as "0/s" would read as "nothing happened".
    const shown =
      direction === "achieved" ? Math.floor(value * 100) / 100 : Math.ceil(value * 100) / 100;
    return `${String(shown)}/s`;
  }
  const shown = direction === "achieved" ? Math.floor(value) : Math.ceil(value);
  return `${shown.toLocaleString("en-US")}/s`;
};

/**
 * The caveat that has to travel with a clamped distribution.
 *
 * Per row, not per scenario: `scheduledLatency` is ≥ `latency` by construction, so it reaches the
 * histogram ceiling **first** — warning only about the send-side distribution would stay silent on
 * exactly the coordinated-omission run D1-01 was written for.
 */
const lowerBoundNote = (label: string, summary: LatencySummary | undefined): string | undefined =>
  summary?.isLowerBound === true
    ? `    ⚠ ${label}: ${String(summary.overflowCount)} samples exceeded the histogram ceiling — those percentiles are lower bounds, not measurements`
    : undefined;

const percentiles = (label: string, summary: LatencySummary | undefined): string =>
  `    ${label}  p50 ${ms(summary?.p50Ms)} · p95 ${ms(summary?.p95Ms)} · p99 ${ms(summary?.p99Ms)}`;

const scenarioLines = (scenario: ScenarioRunSummary): readonly string[] => {
  const lines = [
    `  ${scenario.name}`,
    `    requests    ${String(scenario.scheduledCount)} scheduled · ${String(scenario.dispatchedCount)} sent · ${String(scenario.responseCount)} answered`,
  ];

  // Only shown when non-zero, so a clean run reads clean — but never summarised away, because the
  // achieved rate below is only interpretable next to what did not happen.
  const shortfalls = [
    scenario.droppedCount > 0 ? `${String(scenario.droppedCount)} dropped` : undefined,
    scenario.errorCount > 0 ? `${String(scenario.errorCount)} failed` : undefined,
    scenario.abandonedCount > 0 ? `${String(scenario.abandonedCount)} abandoned` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (shortfalls.length > 0) {
    lines.push(`    shortfall   ${shortfalls.join(" · ")}`);
  }

  // A burst asks for a *count*, not a rate, so both sides are undefined and the row would read
  // `— · —` — indistinguishable from "not known". Saying why is better than printing dashes.
  if (scenario.requestedRatePerSecond === undefined) {
    lines.push(`    rate        n/a — a burst asks for a count, not a rate`);
  } else {
    lines.push(
      `    rate        ${rate(scenario.requestedRatePerSecond, "requested")} requested · ${rate(scenario.achievedRatePerSecond, "achieved")} achieved`,
    );
  }

  lines.push(percentiles("latency   ", scenario.latencyMs));
  lines.push(percentiles("as queued ", scenario.scheduledLatencyMs));

  // The generator's own backlog, shown only when it is real. If this is large the run says more
  // about stampede's machine than about the target, and a reader has to be told rather than left
  // to infer it from a gap between two latency rows.
  const lagMs = scenario.scheduleLagMs?.maxMs;
  if (lagMs !== undefined && lagMs >= 1) {
    lines.push(`    backlog     ${ms(lagMs)} max — the generator's own lateness, not the target's`);
  }

  lines.push(
    ...[
      lowerBoundNote("latency", scenario.latencyMs),
      lowerBoundNote("as queued", scenario.scheduledLatencyMs),
    ].filter((note): note is string => note !== undefined),
  );

  return lines;
};

export const renderSummary = (summary: RunSummary): string =>
  [
    "",
    // "peak in flight" is a sum of independent per-thread maxima, so it is an upper bound rather
    // than something anyone observed — the threads peaked whenever they peaked. Said, not implied.
    `run finished in ${(summary.elapsedMs / 1000).toFixed(1)}s · peak in flight ≤ ${String(summary.maxObservedInFlight)} (sum of per-thread peaks)`,
    "",
    ...summary.scenarios.flatMap((scenario) => [...scenarioLines(scenario), ""]),
  ].join("\n");

export const renderVerdict = (verdict: Verdict): string => {
  if (verdict.results.length === 0) {
    return "no thresholds declared — nothing was asserted about this run\n";
  }
  const lines = verdict.results.map((result) => {
    if (result.error !== undefined) {
      return `  BROKEN  ${result.name} — ${result.error}`;
    }
    return `  ${result.held ? "PASS  " : "FAIL  "}  ${result.name}`;
  });
  return ["thresholds", ...lines, ""].join("\n");
};

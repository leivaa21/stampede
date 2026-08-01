import type { RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import type { Verdict } from "./thresholds.ts";

/**
 * What a finished run says on a terminal.
 *
 * Plain text, no colour, no cursor tricks: this is the output a CI log keeps, and the live
 * dashboard is a separate consumer of the same summary (D1-07). Every number that could flatter the
 * target is printed next to the one that contradicts it — requested beside achieved, dispatched
 * beside dropped — because a reader should not have to know which field to be suspicious of.
 */

const ms = (value: number | undefined): string =>
  value === undefined ? "—" : `${value.toFixed(1)}ms`;

const rate = (value: number | undefined): string =>
  value === undefined ? "—" : `${Math.round(value).toLocaleString("en-US")}/s`;

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

  lines.push(
    `    rate        ${rate(scenario.requestedRatePerSecond)} requested · ${rate(scenario.achievedRatePerSecond)} achieved`,
  );
  lines.push(
    `    latency     p50 ${ms(scenario.latencyMs?.p50Ms)} · p95 ${ms(scenario.latencyMs?.p95Ms)} · p99 ${ms(scenario.latencyMs?.p99Ms)}`,
  );
  lines.push(
    `    as queued   p50 ${ms(scenario.scheduledLatencyMs?.p50Ms)} · p95 ${ms(scenario.scheduledLatencyMs?.p95Ms)} · p99 ${ms(scenario.scheduledLatencyMs?.p99Ms)}`,
  );

  // The generator's own backlog, shown only when it is real. If this is large the run says more
  // about stampede's machine than about the target, and a reader has to be told rather than left
  // to infer it from a gap between two latency rows.
  const lagMs = scenario.scheduleLagMs?.maxMs;
  if (lagMs !== undefined && lagMs >= 1) {
    lines.push(`    backlog     ${ms(lagMs)} max — the generator's own lateness, not the target's`);
  }
  if (scenario.latencyMs?.isLowerBound === true) {
    lines.push(
      `    ⚠ ${String(scenario.latencyMs.overflowCount)} samples exceeded the histogram ceiling — these latencies are lower bounds`,
    );
  }

  return lines;
};

export const renderSummary = (summary: RunSummary): string =>
  [
    "",
    `run finished in ${(summary.elapsedMs / 1000).toFixed(1)}s · peak in flight ${String(summary.maxObservedInFlight)}`,
    "",
    ...summary.scenarios.flatMap((scenario) => [...scenarioLines(scenario), ""]),
  ].join("\n");

export const renderVerdict = (verdict: Verdict): string => {
  if (verdict.results.length === 0) {
    return "no thresholds declared — nothing was asserted about this run\n";
  }
  const lines = verdict.results.map((result) => {
    if (result.error !== undefined) {
      return `  BROKEN  ${result.name} — the predicate threw: ${result.error}`;
    }
    return `  ${result.held ? "PASS  " : "FAIL  "}  ${result.name}`;
  });
  return ["thresholds", ...lines, ""].join("\n");
};

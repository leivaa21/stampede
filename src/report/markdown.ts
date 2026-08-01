import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import type { Verdict } from "../cli/thresholds.ts";

/**
 * The markdown report — the "prove your numbers" half of the pitch.
 *
 * This is written to be **pasted into a README**, which is the whole reason it exists and also the
 * reason it is careful: a table in a README outlives the run that produced it and gets read by
 * people who cannot re-run it. So it carries its own provenance (version, worker count, when), and
 * every caveat that applies to a number sits in the same table as the number — a clamped percentile
 * that loses its footnote on the way to a README becomes a measurement nobody can challenge.
 *
 * A consumer of the engine's output, like the terminal renderer, never the other way round (D1-07).
 */

export interface ReportContext {
  readonly version: string;
  readonly configPath: string;
  readonly workerCount: number;
  /** Passed in rather than read here, so the report is a pure function and tests can fix it. */
  readonly generatedAt: Date;
}

const ms = (value: number | undefined): string =>
  value === undefined ? "—" : `${value.toFixed(1)}ms`;

/** Away from flattering the target, exactly as the terminal renderer does. */
const rate = (value: number | undefined, direction: "requested" | "achieved"): string => {
  if (value === undefined) {
    return "—";
  }
  const round = direction === "achieved" ? Math.floor : Math.ceil;
  if (value < 10) {
    return `${String(round(value * 100) / 100)}/s`;
  }
  return `${round(value).toLocaleString("en-US")}/s`;
};

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const percentileTable = (scenario: ScenarioRunSummary): string =>
  table(
    ["percentile", "latency", "as queued (D1-01)"],
    (
      [
        ["p50", "p50Ms"],
        ["p95", "p95Ms"],
        ["p99", "p99Ms"],
        ["p99.9", "p999Ms"],
        ["max", "maxMs"],
      ] as const
    ).map(([label, key]) => [
      label,
      ms(scenario.latencyMs?.[key]),
      ms(scenario.scheduledLatencyMs?.[key]),
    ]),
  );

const shortfallOf = (scenario: ScenarioRunSummary): string => {
  const parts = [
    scenario.droppedCount > 0 ? `${String(scenario.droppedCount)} dropped` : undefined,
    scenario.errorCount > 0 ? `${String(scenario.errorCount)} failed` : undefined,
    scenario.abandonedCount > 0 ? `${String(scenario.abandonedCount)} abandoned` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "none" : parts.join(" · ");
};

/**
 * The caveat, in the report rather than beside it.
 *
 * A percentile drawn from clamped samples understates the truth without bound, and a table pasted
 * into a README is exactly where that footnote would get lost.
 */
const clampNote = (label: string, summary: LatencySummary | undefined): string | undefined =>
  summary?.isLowerBound === true
    ? `> ⚠ **${label}**: ${String(summary.overflowCount)} samples exceeded the histogram ceiling. Those percentiles are **lower bounds**, not measurements — the real values are higher.`
    : undefined;

const scenarioSection = (scenario: ScenarioRunSummary): string => {
  const facts: string[][] = [
    [
      "requests",
      `${String(scenario.scheduledCount)} scheduled · ${String(scenario.dispatchedCount)} sent · ${String(scenario.responseCount)} answered`,
    ],
    ["shortfall", shortfallOf(scenario)],
  ];

  facts.push(
    scenario.requestedRatePerSecond === undefined
      ? ["rate", "n/a — a burst asks for a count, not a rate"]
      : [
          "rate",
          `${rate(scenario.requestedRatePerSecond, "requested")} requested · **${rate(scenario.achievedRatePerSecond, "achieved")} achieved**`,
        ],
  );

  const lagMs = scenario.scheduleLagMs?.maxMs;
  if (lagMs !== undefined && lagMs >= 1) {
    facts.push([
      "generator backlog",
      `${ms(lagMs)} max — stampede's own lateness, already inside "as queued"`,
    ]);
  }

  const notes = [
    clampNote("latency", scenario.latencyMs),
    clampNote("as queued", scenario.scheduledLatencyMs),
  ].filter((note): note is string => note !== undefined);

  return [
    `### ${scenario.name}`,
    "",
    table(["", ""], facts),
    "",
    percentileTable(scenario),
    ...(notes.length > 0 ? ["", ...notes] : []),
  ].join("\n");
};

const verdictSection = (verdict: Verdict | undefined): readonly string[] => {
  if (verdict === undefined || verdict.results.length === 0) {
    return [
      "### Thresholds",
      "",
      "_No thresholds were declared — this run measured, but asserted nothing._",
    ];
  }
  return [
    "### Thresholds",
    "",
    table(
      ["", "claim"],
      verdict.results.map((result) => [
        result.error !== undefined ? "**BROKEN**" : result.held ? "PASS" : "**FAIL**",
        result.error !== undefined ? `${result.name} — ${result.error}` : result.name,
      ]),
    ),
  ];
};

export const renderMarkdownReport = (
  summary: RunSummary,
  verdict: Verdict | undefined,
  context: ReportContext,
): string =>
  [
    "## Load test",
    "",
    // Provenance first: a table without it is a number with no way to challenge it.
    `\`stampede ${context.version}\` · ${String(context.workerCount)} worker thread${context.workerCount === 1 ? "" : "s"} · \`${context.configPath}\``,
    `Run took ${(summary.elapsedMs / 1000).toFixed(1)}s · peak in flight ≤ ${String(summary.maxObservedInFlight)} (sum of per-thread peaks) · ${context.generatedAt.toISOString()}`,
    "",
    ...summary.scenarios.flatMap((scenario) => [scenarioSection(scenario), ""]),
    ...verdictSection(verdict),
    "",
  ].join("\n");

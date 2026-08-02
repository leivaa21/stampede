import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import type { Verdict } from "../cli/thresholds.ts";
import { cell, codeSpan, duration, ms, rate } from "./format.ts";

/**
 * The markdown report — the "prove your numbers" half of the pitch.
 *
 * This is written to be **pasted into a README**, which is the whole reason it exists and also the
 * reason it is careful: a table in a README outlives the run that produced it and gets read by
 * people who cannot re-run it. So it carries its own provenance, every caveat sits in the same
 * table as the number it qualifies, and — the thing that took a review to get right — **a failed
 * run must look failed**. A green-looking table published for a run whose invariant broke is the
 * single worst artefact this tool could produce.
 *
 * A consumer of the engine's output, like the terminal renderer, never the other way round (D1-07).
 */

export interface ReportContext {
  readonly version: string;
  readonly configPath: string;
  readonly workerCount: number;
  readonly maxInFlight: number;
  readonly drainTimeoutMs: number;
  /** Non-zero means the run did not pass; the text is what went wrong. */
  readonly failure: string | undefined;
  /** Snapshots discarded for arriving out of order — zero in normal operation. */
  readonly supersededSnapshots: number;
  /** Passed in rather than read here, so the report is a pure function and tests can fix it. */
  readonly generatedAt: Date;
}

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

/**
 * Saturation is not a lower bound — it is samples *dropped from the histogram*.
 *
 * Practically unreachable at M1 scale (2³¹ samples in one bucket), but while it renders nowhere the
 * claim that every caveat sits in the table is overstated, and this is the one caveat that distorts
 * a percentile in either direction rather than only downward.
 */
const saturationNote = (label: string, summary: LatencySummary | undefined): string | undefined =>
  summary?.saturated === true
    ? `> ⚠ **${label}**: a histogram bucket saturated and samples were dropped. These percentiles are distorted, not merely bounded.`
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
          `${rate(scenario.requestedRatePerSecond, "requested")} requested · **${rate(scenario.achievedRatePerSecond, "achieved")} achieved** (averaged over the profile's span)`,
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
    saturationNote("latency", scenario.latencyMs),
    saturationNote("as queued", scenario.scheduledLatencyMs),
  ].filter((note): note is string => note !== undefined);

  const checkRows = Object.entries(scenario.checks).map(([name, tally]) => [
    tally.failed === 0 ? "PASS" : "**FAIL**",
    cell(name),
    String(tally.passed),
    String(tally.failed),
  ]);
  const counterRows = Object.entries(scenario.counters).map(([name, value]) => [
    cell(name),
    String(value),
  ]);
  const trendRows = Object.entries(scenario.trends).map(([name, trend]) => [
    cell(name),
    ms(trend.p50Ms),
    ms(trend.p99Ms),
    ms(trend.maxMs),
  ]);

  return [
    `### ${cell(scenario.name)}`,
    "",
    table(["", ""], facts),
    "",
    percentileTable(scenario),
    // The checks table the contract asked for by name. Printed whenever a scenario declared any,
    // because "every check passed" and "no checks were declared" must not render identically.
    ...(checkRows.length > 0 ? ["", table(["", "check", "passed", "failed"], checkRows)] : []),
    ...(counterRows.length > 0 ? ["", table(["counter", "total"], counterRows)] : []),
    ...(trendRows.length > 0 ? ["", table(["recorded", "p50", "p99", "max"], trendRows)] : []),
    ...(scenario.brokenObservations > 0
      ? [
          "",
          `> ⚠ **${String(scenario.brokenObservations)} broken observations** — a check threw or returned a non-boolean. The measurements are real; at least one claim about them is not.`,
        ]
      : []),
    // Blank `>` between notes, or GitHub merges adjacent blockquote lines into one paragraph and
    // the two warnings run together into a wall of text.
    ...(notes.length > 0 ? ["", notes.join("\n>\n")] : []),
  ].join("\n");
};

const verdictSection = (
  verdict: Verdict | undefined,
  failure: string | undefined,
): readonly string[] => {
  if (verdict === undefined) {
    // Two very different situations that must not share a sentence. A run that failed before its
    // thresholds could be evaluated is not a run that declared none — saying "asserted nothing"
    // there publishes a clean-looking table for a run whose invariant broke.
    return [
      "### Thresholds",
      "",
      failure === undefined
        ? "_No thresholds were declared — this run measured, but asserted nothing._"
        : "_Not evaluated — the run failed first. See the verdict above._",
    ];
  }
  if (verdict.results.length === 0) {
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
        result.error !== undefined
          ? `${cell(result.name)} — ${cell(result.error)}`
          : cell(result.name),
      ]),
    ),
  ];
};

export const renderMarkdownReport = (
  summary: RunSummary,
  verdict: Verdict | undefined,
  context: ReportContext,
): string => {
  const failed = context.failure !== undefined || (verdict?.violated.length ?? 0) > 0;

  return [
    "## Load test",
    "",
    // The verdict first, in bold, before any number. A reader skimming a pasted table has to learn
    // that the run failed before they read a percentile from it.
    failed
      ? `**FAILED** — ${cell(context.failure ?? `${String(verdict?.violated.length ?? 0)} threshold(s) violated`)}`
      : "**PASSED** — every declared threshold held.",
    "",
    // Two spaces end the line: GitHub collapses a single newline, which would run the provenance
    // into one paragraph with the line below it.
    `${codeSpan(`stampede ${context.version}`)} · ${String(context.workerCount)} worker thread${context.workerCount === 1 ? "" : "s"} · config ${codeSpan(context.configPath)}  `,
    `Run took ${duration(summary.elapsedMs)} · peak in flight ≤ ${String(summary.maxObservedInFlight)} (sum of per-thread peaks) · ${context.generatedAt.toISOString()}  `,
    // The two numbers that make `dropped` and `abandoned` interpretable: without them a reader
    // cannot tell whether a shortfall indicts the target or the settings it was run with.
    `Settings: \`maxInFlight\` ${String(context.maxInFlight)} · \`drainTimeoutMs\` ${String(context.drainTimeoutMs)}`,
    ...(context.supersededSnapshots > 0
      ? [
          "",
          `> ⚠ ${String(context.supersededSnapshots)} worker snapshots arrived out of order and were discarded. The totals below may be incomplete.`,
        ]
      : []),
    "",
    ...summary.scenarios.flatMap((scenario) => [scenarioSection(scenario), ""]),
    ...verdictSection(verdict, context.failure),
    "",
  ].join("\n");
};

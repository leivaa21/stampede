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
  /** One reason per entry — see `RunReport.failures`. Empty when the run came out clean. */
  readonly failures: readonly string[];
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
    scenario.requestErrorCount > 0 ? `${String(scenario.requestErrorCount)} not built` : undefined,
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

  // A broken check is neither PASS nor FAIL. Collapsing it into FAIL published a table saying the
  // target broke an invariant 500 times when the predicate had a typo (D2-04); collapsing it into
  // PASS would publish a green claim nothing ever verified.
  const checkRows = Object.entries(scenario.checks).map(([name, tally]) => [
    tally.broken > 0 ? "**BROKEN**" : tally.failed === 0 ? "PASS" : "**FAIL**",
    cell(name),
    String(tally.passed),
    String(tally.failed),
    String(tally.broken),
  ]);
  const counterRows = Object.entries(scenario.counters).map(([name, value]) => [
    cell(name),
    String(value),
  ]);
  // A row per counter, a column per key — the shape a declared key space is for. `other` is always
  // last regardless of declaration order, because it is the bucket rather than one of the keys.
  const keyedRows = Object.entries(scenario.keyedCounters).map(([name, keys]) => [
    cell(name),
    ...Object.entries(keys)
      .sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : 0))
      .map(([key, value]) => `${cell(key)} ${String(value)}`),
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
    ...(checkRows.length > 0
      ? ["", table(["", "check", "passed", "failed", "broken"], checkRows)]
      : []),
    ...(counterRows.length > 0 ? ["", table(["counter", "total"], counterRows)] : []),
    ...keyedRows.map((row) => `\n**${row[0] ?? ""}** — ${row.slice(1).join(" · ")}`),
    ...(trendRows.length > 0 ? ["", table(["recorded", "p50", "p99", "max"], trendRows)] : []),
    ...(scenario.brokenObservations > 0
      ? [
          "",
          `> ⚠ **${String(scenario.brokenObservations)} broken observations** — a check or \`onResponse\` threw, returned a non-boolean, or named a metric the scenario never declared. The measurements are real; at least one claim about them is not.`,
        ]
      : []),
    ...(scenario.refusedRecordings > 0
      ? [
          "",
          `> ⚠ **${String(scenario.refusedRecordings)} recordings refused** — this scenario asked for more distinct metric names than a per-scenario cap allows (512 counters, 512 checks, 32 distributions), so some rows are missing from the tables above **entirely**, not merely undercounted.`,
        ]
      : []),
    // Blank `>` between notes, or GitHub merges adjacent blockquote lines into one paragraph and
    // the two warnings run together into a wall of text.
    ...(notes.length > 0 ? ["", notes.join("\n>\n")] : []),
  ].join("\n");
};

const verdictSection = (
  verdict: Verdict | undefined,
  failures: readonly string[],
): readonly string[] => {
  // Two independent facts — were thresholds evaluated, and did anything go wrong — and all four
  // combinations say something different. Collapsing any pair of them is how "this run measured,
  // but asserted nothing" ended up printed directly beneath "**FAILED** — double sell: 2 sold".
  const noThresholdRows = (evaluated: boolean): readonly string[] => [
    "### Thresholds",
    "",
    failures.length > 0
      ? evaluated
        ? "_None were declared, and the run failed for the reasons above._"
        : "_Not evaluated — the run failed first. See the verdict above._"
      : "_No thresholds were declared — this run measured, but asserted nothing._",
  ];

  if (verdict === undefined) {
    return noThresholdRows(false);
  }
  if (verdict.results.length === 0) {
    return noThresholdRows(true);
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

/**
 * The verdict line, and the reasons under it — one bullet each, never one paragraph.
 *
 * `cell()` is table-cell escaping, and running a multi-reason failure through it flattened every
 * newline into a space: four reasons became a 700-character sentence with the double sell buried
 * at the end of a clause about cardinality caps, in the artifact designed to be pasted into a
 * README. One reason still reads as a headline; several read as a list.
 */
const failureHeadline = (failures: readonly string[], verdict: Verdict | undefined): string => {
  if (failures.length === 0) {
    return `**FAILED** — ${String(verdict?.violated.length ?? 0)} threshold(s) violated`;
  }
  if (failures.length === 1) {
    return `**FAILED** — ${cell(failures[0] ?? "")}`;
  }
  return [
    "**FAILED** — several things went wrong:",
    "",
    ...failures.map((f) => `- ${cell(f)}`),
  ].join("\n");
};

export const renderMarkdownReport = (
  summary: RunSummary,
  verdict: Verdict | undefined,
  context: ReportContext,
): string => {
  const failed = context.failures.length > 0 || (verdict?.violated.length ?? 0) > 0;

  return [
    "## Load test",
    "",
    // The verdict first, in bold, before any number. A reader skimming a pasted table has to learn
    // that the run failed before they read a percentile from it.
    failed
      ? failureHeadline(context.failures, verdict)
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
    ...verdictSection(verdict, context.failures),
    "",
  ].join("\n");
};

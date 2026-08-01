import { describe, expect, it } from "vitest";
import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import { renderMarkdownReport, type ReportContext } from "./markdown.ts";

/**
 * The report is the artefact that outlives the run.
 *
 * Everything asserted here is about a table that will be pasted into a README and read by people
 * who cannot re-run it: the caveats have to travel *with* the numbers, the rounding has to go away
 * from flattering the target, and the provenance has to survive the copy-paste. A footnote lost on
 * the way to a README turns a lower bound into a measurement nobody can challenge.
 */

const latency = (over: Partial<LatencySummary> = {}): LatencySummary => ({
  count: 10,
  minMs: 1,
  maxMs: 9,
  meanMs: 5,
  p50Ms: 4,
  p95Ms: 8,
  p99Ms: 9,
  p999Ms: 9,
  overflowCount: 0,
  saturated: false,
  isLowerBound: false,
  ...over,
});

const scenario = (over: Partial<ScenarioRunSummary> = {}): ScenarioRunSummary => ({
  name: "theStampede",
  scheduledCount: 500,
  dispatchedCount: 500,
  droppedCount: 0,
  responseCount: 500,
  errorCount: 0,
  abandonedCount: 0,
  requestedRatePerSecond: 250,
  achievedRatePerSecond: 250,
  latencyMs: latency(),
  scheduledLatencyMs: latency(),
  scheduleLagMs: undefined,
  ...over,
});

const summaryOf = (...scenarios: readonly ScenarioRunSummary[]): RunSummary => ({
  elapsedMs: 2_000,
  scenarios,
  droppedCount: 0,
  abandonedCount: 0,
  maxObservedInFlight: 512,
});

const context: ReportContext = {
  version: "1.2.3",
  configPath: "scenarios.ts",
  workerCount: 4,
  generatedAt: new Date("2026-07-31T12:00:00.000Z"),
};

const render = (summary: RunSummary, verdict?: Parameters<typeof renderMarkdownReport>[1]) =>
  renderMarkdownReport(summary, verdict, context);

describe("renderMarkdownReport", () => {
  it("carries its own provenance, so a pasted table can be challenged", () => {
    const text = render(summaryOf(scenario()));

    expect(text).toContain("`stampede 1.2.3`");
    expect(text).toContain("4 worker threads");
    expect(text).toContain("`scenarios.ts`");
    expect(text).toContain("2026-07-31T12:00:00.000Z");
  });

  it("says one worker without an s", () => {
    expect(render(summaryOf(scenario()), undefined).length).toBeGreaterThan(0);
    expect(
      renderMarkdownReport(summaryOf(scenario()), undefined, { ...context, workerCount: 1 }),
    ).toContain("1 worker thread ·");
  });

  it("prints achieved beside requested, and never rounds the gap away", () => {
    const text = render(
      summaryOf(scenario({ requestedRatePerSecond: 999.4, achievedRatePerSecond: 999.6 })),
    );

    expect(text).toContain("1,000/s requested");
    expect(text).toContain("999/s achieved");
  });

  it("gives both distributions their own percentile column", () => {
    const text = render(
      summaryOf(
        scenario({
          latencyMs: latency({ p99Ms: 12 }),
          scheduledLatencyMs: latency({ p99Ms: 340 }),
        }),
      ),
    );

    expect(text).toContain("| percentile | latency | as queued (D1-01) |");
    expect(text).toContain("| p99 | 12.0ms | 340.0ms |");
  });

  it("keeps the clamped-samples caveat in the report, not beside it", () => {
    // The one that matters most for a pasted table: without this the ceiling reads as a measurement.
    const text = render(
      summaryOf(
        scenario({ scheduledLatencyMs: latency({ isLowerBound: true, overflowCount: 4_211 }) }),
      ),
    );

    expect(text).toContain("**as queued**: 4211 samples exceeded the histogram ceiling");
    expect(text).toContain("**lower bounds**");
  });

  it("says shortfall none rather than omitting the row", () => {
    // An absent row reads as "not measured". "none" is a claim.
    expect(render(summaryOf(scenario()))).toContain("| shortfall | none |");
  });

  it("lists every shortfall it has", () => {
    const text = render(
      summaryOf(scenario({ droppedCount: 12, errorCount: 3, abandonedCount: 1 })),
    );

    expect(text).toContain("12 dropped · 3 failed · 1 abandoned");
  });

  it("explains a burst instead of printing a dash for its rate", () => {
    const text = render(
      summaryOf(scenario({ requestedRatePerSecond: undefined, achievedRatePerSecond: undefined })),
    );

    expect(text).toContain("a burst asks for a count, not a rate");
  });

  it("calls peak in flight an upper bound", () => {
    expect(render(summaryOf(scenario()))).toContain(
      "peak in flight ≤ 512 (sum of per-thread peaks)",
    );
  });

  it("gives each scenario its own section", () => {
    const text = render(summaryOf(scenario({ name: "reads" }), scenario({ name: "writes" })));

    expect(text).toContain("### reads");
    expect(text).toContain("### writes");
  });

  it("marks a failed threshold in bold so it survives a skim", () => {
    const text = render(summaryOf(scenario()), {
      results: [
        { name: "exactly one buyer wins", held: true, error: undefined },
        { name: "p99 under 250ms", held: false, error: undefined },
      ],
      violated: ["p99 under 250ms"],
      broken: [],
    });

    expect(text).toContain("| PASS | exactly one buyer wins |");
    expect(text).toContain("| **FAIL** | p99 under 250ms |");
  });

  it("shows a broken predicate as broken, with its reason", () => {
    const text = render(summaryOf(scenario()), {
      results: [{ name: "bad claim", held: false, error: "cannot read x of undefined" }],
      violated: [],
      broken: ["bad claim"],
    });

    expect(text).toContain("| **BROKEN** | bad claim — cannot read x of undefined |");
  });

  it("says plainly when a run asserted nothing", () => {
    // A report with no threshold table would look like a run that passed.
    expect(render(summaryOf(scenario()), undefined)).toContain("asserted nothing");
  });

  it("produces a table a markdown renderer will accept", () => {
    const text = render(summaryOf(scenario()));
    const tableLines = text.split("\n").filter((line) => line.startsWith("|"));

    expect(tableLines.length).toBeGreaterThan(6);
    // Every row is delimited on both sides — the difference between a table and a paragraph of pipes.
    for (const line of tableLines) {
      expect(line.endsWith("|")).toBe(true);
    }
  });
});

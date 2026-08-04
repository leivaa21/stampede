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

/**
 * Every field gets a **distinct** value on purpose.
 *
 * The first version of this fixture had p99 === p99.9 === max and scheduled === sent === answered,
 * so a report row labelled `p50` could have printed the p95 value and every test here would still
 * have passed. A mislabelled percentile in a durable artefact is the exact defect this file exists
 * to prevent, so no two fields may share a value.
 */
const latency = (over: Partial<LatencySummary> = {}): LatencySummary => ({
  count: 10,
  minMs: 1,
  maxMs: 90,
  meanMs: 5,
  p50Ms: 4,
  p95Ms: 8,
  p99Ms: 16,
  p999Ms: 32,
  overflowCount: 0,
  saturated: false,
  isLowerBound: false,
  ...over,
});

const scenario = (over: Partial<ScenarioRunSummary> = {}): ScenarioRunSummary => ({
  name: "theStampede",
  scheduledCount: 500,
  dispatchedCount: 498,
  droppedCount: 2,
  requestErrorCount: 0,
  impureRequestCount: 0,
  responseCount: 497,
  errorCount: 1,
  abandonedCount: 0,
  requestedRatePerSecond: 250,
  achievedRatePerSecond: 250,
  latencyMs: latency(),
  scheduledLatencyMs: latency(),
  scheduleLagMs: undefined,
  counters: {},
  keyedCounters: {},
  checks: {},
  trends: {},
  brokenObservations: 0,
  refusedRecordings: 0,
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
  maxInFlight: 500,
  drainTimeoutMs: 30_000,
  failures: [],
  supersededSnapshots: 0,
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

  it("puts every percentile in the row that is labelled with it", () => {
    // Whole rows, distinct values: a swapped p50/p95 mapping or a p99.9 row secretly reading p99
    // both survived an assertion on one cell.
    const text = render(
      summaryOf(
        scenario({
          latencyMs: latency(),
          scheduledLatencyMs: latency({
            p50Ms: 40,
            p95Ms: 80,
            p99Ms: 160,
            p999Ms: 320,
            maxMs: 900,
          }),
        }),
      ),
    );

    expect(text).toContain("| percentile | latency | as queued (D1-01) |");
    expect(text).toContain("| p50 | 4.0ms | 40.0ms |");
    expect(text).toContain("| p95 | 8.0ms | 80.0ms |");
    expect(text).toContain("| p99 | 16.0ms | 160.0ms |");
    expect(text).toContain("| p99.9 | 32.0ms | 320.0ms |");
    expect(text).toContain("| max | 90.0ms | 900.0ms |");
  });

  it("reports the three request counts in the order it labels them", () => {
    expect(render(summaryOf(scenario()))).toContain(
      "| requests | 500 scheduled · 498 sent · 497 answered |",
    );
  });

  it("shows a single dropped request rather than rounding it away", () => {
    expect(render(summaryOf(scenario({ droppedCount: 1, errorCount: 0 })))).toContain(
      "| shortfall | 1 dropped |",
    );
  });

  it("warns about a clamped send-side distribution too, not only the queued one", () => {
    const text = render(
      summaryOf(scenario({ latencyMs: latency({ isLowerBound: true, overflowCount: 5 }) })),
    );

    expect(text).toContain("**latency**: 5 samples exceeded");
  });

  it("says a saturated histogram is distorted, not merely bounded", () => {
    const text = render(summaryOf(scenario({ latencyMs: latency({ saturated: true }) })));

    expect(text).toContain("distorted, not merely bounded");
  });

  it("shows the generator's own backlog when there was one", () => {
    const text = render(
      summaryOf(
        scenario({
          scheduleLagMs: {
            count: 1,
            minMs: 0,
            maxMs: 41,
            meanMs: 20,
            p50Ms: 20,
            p95Ms: 40,
            p99Ms: 41,
            p999Ms: 41,
            overflowCount: 0,
            saturated: false,
            isLowerBound: false,
          },
        }),
      ),
    );

    expect(text).toContain("| generator backlog | 41.0ms max");
  });

  it("prints the settings that make dropped and abandoned interpretable", () => {
    // "12 dropped" indicts the target or the generator depending entirely on the cap; "1 abandoned"
    // is uninterpretable without knowing whether the run waited one second or sixty.
    const text = render(summaryOf(scenario()));

    expect(text).toContain("`maxInFlight` 500");
    expect(text).toContain("`drainTimeoutMs` 30000");
  });

  it("prints sub-second runs in ms rather than a flat 0.0s", () => {
    const text = renderMarkdownReport(
      { ...summaryOf(scenario()), elapsedMs: 220 },
      undefined,
      context,
    );

    expect(text).toContain("Run took 220ms");
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
    expect(
      render(summaryOf(scenario({ droppedCount: 0, errorCount: 0, abandonedCount: 0 }))),
    ).toContain("| shortfall | none |");
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

  it("prints the checks table the contract asked for by name", () => {
    const text = render(
      summaryOf(
        scenario({
          checks: {
            oneWinnerOrConflict: { passed: 500, failed: 0, broken: 0 },
            noDoubleSell: { passed: 480, failed: 20, broken: 0 },
          },
        }),
      ),
    );

    // Whole rows, terminated: `toContain("| PASS | oneWinnerOrConflict | 500 | 0 |")` also matches
    // a row with a fourth column after it, so the assertion survived the column being added.
    expect(text).toContain("|  | check | passed | failed | broken |\n");
    expect(text).toContain("| PASS | oneWinnerOrConflict | 500 | 0 | 0 |\n");
    // Bold, so a failure survives a skim of a pasted table.
    expect(text).toContain("| **FAIL** | noDoubleSell | 480 | 20 | 0 |\n");
  });

  it("publishes a broken check as BROKEN, never as a pass and never as a target failure", () => {
    // This table gets pasted into a README and outlives the run that produced it. `| PASS |` here
    // is a green claim nobody verified; `| **FAIL** |` accuses the target of double-selling 500
    // seats because a predicate had a typo (D2-04).
    const text = render(
      summaryOf(
        scenario({ checks: { oneWinnerOrConflict: { passed: 0, failed: 0, broken: 500 } } }),
      ),
    );

    expect(text).toContain("| **BROKEN** | oneWinnerOrConflict | 0 | 0 | 500 |\n");
  });

  it("marks a check broken even when most responses passed it", () => {
    // A check that broke on 40 of 500 responses is not a check anyone should read a verdict from,
    // and 460 passes must not out-vote the fact that the predicate is unsound.
    const text = render(
      summaryOf(scenario({ checks: { parsesBody: { passed: 460, failed: 0, broken: 40 } } })),
    );

    expect(text).toContain("| **BROKEN** | parsesBody | 460 | 0 | 40 |\n");
  });

  it("publishes a declared key space, with `other` last", () => {
    const text = render(
      summaryOf(scenario({ keyedCounters: { byStatus: { other: 3, "5xx": 2, "2xx": 40 } } })),
    );

    // `other` is the bucket rather than one of the keys, so it sorts last however it was declared.
    expect(text).toContain("| byStatus | count |");
    expect(text).toContain("| 2xx | 40 |");
    expect(text).toContain("| 5xx | 2 |");
    expect(text.indexOf("| other | 3 |")).toBeGreaterThan(text.indexOf("| 5xx | 2 |"));
  });

  it("says when recordings were refused, so a missing counter is not read as a zero", () => {
    const text = render(summaryOf(scenario({ refusedRecordings: 88 })));

    expect(text).toContain("**88 recordings refused**");
  });

  it("names an impure builder in the shortfall", () => {
    const report = render(
      summaryOf(scenario({ scheduledCount: 10, dispatchedCount: 1, impureRequestCount: 9 })),
    );

    expect(report).toContain("9 not built (impure request())");
  });

  it("names requests the config could not build in the shortfall", () => {
    const text = render(
      summaryOf(scenario({ scheduledCount: 100, dispatchedCount: 90, requestErrorCount: 10 })),
    );

    expect(text).toContain("10 not built");
  });

  it("prints counters and recorded distributions when a scenario has them", () => {
    const text = render(
      summaryOf(
        scenario({
          counters: { reserved201: 1 },
          trends: {
            behindMs: {
              count: 3,
              minMs: 1,
              maxMs: 40,
              meanMs: 20,
              p50Ms: 18,
              p95Ms: 38,
              p99Ms: 39,
              p999Ms: 40,
              overflowCount: 0,
              saturated: false,
              isLowerBound: false,
            },
          },
        }),
      ),
    );

    expect(text).toContain("| counter | total |");
    expect(text).toContain("| reserved201 | 1 |");
    expect(text).toContain("| recorded | p50 | p99 | max |");
    expect(text).toContain("| behindMs | 18.0ms | 39.0ms | 40.0ms |");
  });

  it("omits the tables entirely when a scenario declared none", () => {
    // An empty table would read as "checked, found nothing" rather than "asserted nothing".
    expect(render(summaryOf(scenario()))).not.toContain("| check | passed |");
  });

  it("says when the assertions themselves are broken", () => {
    expect(render(summaryOf(scenario({ brokenObservations: 3 })))).toContain(
      "**3 broken observations**",
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

  it("leads with PASSED when nothing went wrong", () => {
    expect(render(summaryOf(scenario()), { results: [], violated: [], broken: [] })).toContain(
      "**PASSED**",
    );
  });

  it("leads with FAILED, and does not claim the run asserted nothing", () => {
    // The worst artefact this tool could produce: a green-looking table published for a run whose
    // invariant broke.
    const text = renderMarkdownReport(summaryOf(scenario()), undefined, {
      ...context,
      failures: ["teardown() failed — the invariant did not hold after the run: double sell"],
    });

    expect(text).toContain("**FAILED** — teardown() failed");
    expect(text).toContain("double sell");
    expect(text).not.toContain("asserted nothing");
  });

  it("does not claim a failed run asserted nothing when its verdict is merely empty", () => {
    // The shape the CLI really emits on the teardown path: thresholds *are* evaluated now, so a
    // config that declared none gets an empty verdict rather than no verdict. Keying the sentence
    // on `verdict === undefined` published "this run measured, but asserted nothing" directly
    // under "**FAILED** — double sell: 2 sold".
    const text = renderMarkdownReport(
      summaryOf(scenario()),
      { results: [], violated: [], broken: [] },
      { ...context, failures: ["teardown() failed — double sell: 2 sold"] },
    );

    expect(text).toContain("double sell: 2 sold");
    expect(text).not.toContain("asserted nothing");
  });

  it("lists several failures rather than running them into one paragraph", () => {
    // `cell()` flattens newlines, so a joined failure string became a single 700-character
    // sentence with the double sell buried at the end of a clause about cardinality caps.
    const text = renderMarkdownReport(
      summaryOf(scenario()),
      { results: [], violated: [], broken: [] },
      {
        ...context,
        failures: [
          "a threshold predicate threw: throws",
          'scenario "reads" had 600 broken observations — a check threw',
          "teardown() failed — double sell: 2 sold",
        ],
      },
    );

    expect(text).toContain("**FAILED** — several things went wrong:");
    expect(text).toContain("- teardown() failed — double sell: 2 sold");
    expect(text).toContain("- a threshold predicate threw: throws");
  });

  it("leads with FAILED when a threshold was violated", () => {
    const text = render(summaryOf(scenario()), {
      results: [{ name: "p99 under 250ms", held: false, error: undefined }],
      violated: ["p99 under 250ms"],
      broken: [],
    });

    expect(text).toContain("**FAILED**");
  });

  it("warns when worker snapshots were discarded, because the totals may be short", () => {
    const text = renderMarkdownReport(summaryOf(scenario()), undefined, {
      ...context,
      supersededSnapshots: 3,
    });

    expect(text).toContain("3 worker snapshots arrived out of order");
  });

  it("escapes a pipe in a threshold name instead of losing half the claim", () => {
    // GitHub drops cells past the header's column count, so an unescaped pipe silently truncates a
    // published claim: "p99 | under 250ms" would render as "p99".
    const text = render(summaryOf(scenario()), {
      results: [{ name: "p99 | under 250ms", held: false, error: undefined }],
      violated: ["p99 | under 250ms"],
      broken: [],
    });

    expect(text).toContain("p99 \\| under 250ms");
  });

  it("flattens a multi-line predicate error instead of ending the table", () => {
    // Every node:assert failure is multi-line by construction. A blank line inside a table ends it,
    // and every row below renders as a paragraph of pipes — losing results the report claims to
    // carry.
    const text = render(summaryOf(scenario()), {
      results: [
        { name: "equality", held: false, error: "Expected values to be equal:\n\n1 !== 2" },
        { name: "still here", held: true, error: undefined },
      ],
      violated: [],
      broken: ["equality"],
    });

    const tableLines = text.split("\n").filter((line) => line.startsWith("|"));
    expect(tableLines.some((line) => line.includes("still here"))).toBe(true);
    expect(text).not.toContain("1 !== 2\n");
  });

  it("escapes a pipe in a scenario name", () => {
    expect(render(summaryOf(scenario({ name: "reads | writes" })))).toContain(
      "### reads \\| writes",
    );
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

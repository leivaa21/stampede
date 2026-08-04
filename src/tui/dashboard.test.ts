import { describe, expect, it } from "vitest";
import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import { createDashboard, frameFor } from "./dashboard.ts";

/**
 * The dashboard, tested through the bytes it writes.
 *
 * Two things are worth pinning: that a frame tells the same story the final summary will (a live
 * view that hides drops until the end lets someone watch a broken run for twenty minutes), and that
 * redrawing in place actually clears what it drew — the failure mode there is debris climbing the
 * terminal, which no amount of eyeballing one frame would catch.
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
  name: "reads",
  scheduledCount: 100,
  dispatchedCount: 40,
  droppedCount: 0,
  requestErrorCount: 0,
  impureRequestCount: 0,
  responseCount: 38,
  errorCount: 0,
  abandonedCount: 0,
  requestedRatePerSecond: 100,
  achievedRatePerSecond: 96,
  latencyMs: latency(),
  scheduledLatencyMs: latency({ p99Ms: 64 }),
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
  elapsedMs: 1_500,
  scenarios,
  droppedCount: 0,
  abandonedCount: 0,
  maxObservedInFlight: 64,
});

describe("frameFor", () => {
  it("shows progress as dispatched against scheduled", () => {
    const frame = frameFor(summaryOf(scenario())).join("\n");

    expect(frame).toContain("40/100");
    expect(frame).toContain("38 answered");
  });

  it("surfaces drops and failures the moment they exist", () => {
    // A dashboard that only reveals a shortfall at the end lets someone watch a run they believe is
    // healthy until it is too late to stop it.
    const frame = frameFor(summaryOf(scenario({ droppedCount: 5, errorCount: 2 }))).join("\n");

    expect(frame).toContain("⚠ 5 dropped · 2 failed");
  });

  it("shows an impure builder while the run is still going", () => {
    // The bar counts them as dealt with from the start; without this the shortfall stayed silent,
    // so it raced to 10/10 with one answered and no ⚠ explaining the nine — the twenty-minute
    // silence this file refuses for drops.
    const frame = frameFor(
      summaryOf(scenario({ scheduledCount: 10, dispatchedCount: 1, impureRequestCount: 9 })),
    ).join("\n");

    expect(frame).toContain("9 impure request()");
  });

  it("says nothing about shortfalls when there are none", () => {
    expect(frameFor(summaryOf(scenario())).join("\n")).not.toContain("⚠");
  });

  it("computes the achieved rate from elapsed time, not the configured window", () => {
    // `achievedRatePerSecond` divides by the profile's *whole* window, which is right only at the
    // end. Used mid-run it showed a run issuing exactly its requested rate as a two-thirds
    // shortfall for the entire duration: 200 of 600 dispatched at t+1s of a 3s run read "66/s".
    const frame = frameFor({
      ...summaryOf(
        scenario({
          dispatchedCount: 200,
          scheduledCount: 600,
          requestedRatePerSecond: 200,
          achievedRatePerSecond: 66,
        }),
      ),
      elapsedMs: 1_000,
    }).join("\n");

    expect(frame).toContain("200/s asked · 200/s so far");
    expect(frame).not.toContain("66/s");
  });

  it("says nothing about a rate before any time has passed", () => {
    const frame = frameFor({ ...summaryOf(scenario()), elapsedMs: 0 }).join("\n");

    expect(frame).toContain("— so far");
  });

  it("counts dropped requests as dealt with in the progress bar", () => {
    // A bar that ignored refusals would crawl while the run raced to its end.
    const frame = frameFor(
      summaryOf(scenario({ scheduledCount: 100, dispatchedCount: 40, droppedCount: 60 })),
    ).join("\n");

    expect(frame).toContain("100/100");
  });

  it("fills the bar in proportion to what has been dealt with", () => {
    const empty = frameFor(
      summaryOf(scenario({ scheduledCount: 100, dispatchedCount: 0, droppedCount: 0 })),
    ).join("\n");
    const full = frameFor(summaryOf(scenario({ scheduledCount: 100, dispatchedCount: 100 }))).join(
      "\n",
    );

    expect(empty).toContain("░░░░░░░░░░░░░░░░░░░░░░░░");
    expect(empty).not.toContain("█");
    expect(full).toContain("████████████████████████");
    expect(full).not.toContain("░");
  });

  it("shows the queued percentile beside the raw one", () => {
    // The gap between them is the coordinated-omission story; a live view showing only the flattering
    // one would be the wrong half.
    const frame = frameFor(summaryOf(scenario())).join("\n");

    expect(frame).toContain("p99 16.0ms · queued p99 64.0ms");
  });

  it("surfaces a failing check the moment it fails, not at the end", () => {
    // Waiting for the summary to reveal that every response has been failing for eight minutes is
    // the same mistake as hiding drops, which this file already refuses (D2-05).
    const frame = frameFor(
      summaryOf(scenario({ checks: { noDoubleSell: { passed: 10, failed: 3, broken: 0 } } })),
    ).join("\n");

    expect(frame).toContain("✗ noDoubleSell 3");
  });

  it("stays quiet about checks that are passing", () => {
    // A live view is for what needs attention; a passing check does not.
    const frame = frameFor(
      summaryOf(scenario({ checks: { fine: { passed: 10, failed: 0, broken: 0 } } })),
    ).join("\n");

    expect(frame).not.toContain("✗");
  });

  it("gives every scenario its own block", () => {
    const frame = frameFor(summaryOf(scenario({ name: "reads" }), scenario({ name: "writes" })));

    expect(frame.filter((line) => line.trim() === "reads")).toHaveLength(1);
    expect(frame.filter((line) => line.trim() === "writes")).toHaveLength(1);
  });

  it("does not divide by a zero schedule", () => {
    expect(() =>
      frameFor(summaryOf(scenario({ scheduledCount: 0, dispatchedCount: 0 }))),
    ).not.toThrow();
  });
});

describe("createDashboard", () => {
  const collect = () => {
    const written: string[] = [];
    const dashboard = createDashboard({ write: (text) => written.push(text), columns: 200 });
    return { written, dashboard, text: () => written.join("") };
  };

  it("moves up by exactly the number of lines it drew", () => {
    // The whole basis of drawing in place. Move up by fewer rows than were printed and every
    // redraw leaves a line of debris climbing the terminal.
    const { written, dashboard } = collect();
    const frameHeight = frameFor(summaryOf(scenario())).length;

    dashboard.update(summaryOf(scenario()));
    written.length = 0;
    dashboard.update(summaryOf(scenario()));

    expect(written.join("")).toContain(`[${String(frameHeight)}F`);
  });

  it("draws nothing to move up over on the first frame", () => {
    const { written, dashboard } = collect();
    written.length = 0;

    dashboard.update(summaryOf(scenario()));

    expect(written.join("")).not.toContain("F[J");
  });

  it("clears its frame and restores the cursor when it stops", () => {
    // Otherwise the final summary prints underneath a stale frame, and the terminal keeps an
    // invisible cursor after the process exits.
    const { written, dashboard, text } = collect();
    dashboard.update(summaryOf(scenario()));
    written.length = 0;

    dashboard.stop();

    expect(text()).toContain("[J");
    expect(text()).toContain("[?25h");
  });

  /** The rows actually printed, with the escape sequences stripped. */
  const rowsOf = (written: readonly string[]): readonly string[] =>
    written
      .join("")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9?]*[A-Za-z]/g, "")
      .split("\n")
      .filter((line) => line.length > 0);

  it("prints exactly as many rows as it will later move up over", () => {
    // The invariant the whole design rests on. A line that wraps occupies two rows while counting
    // as one, so the next redraw moves up too little and leaves debris climbing the terminal.
    const written: string[] = [];
    const narrow = createDashboard({ write: (t) => written.push(t), columns: 60 });

    narrow.update(summaryOf(scenario({ name: "an-extremely-long-scenario-name-that-would-wrap" })));

    const rows = rowsOf(written);
    expect(rows).toHaveLength(frameFor(summaryOf(scenario())).length);
    for (const row of rows) {
      expect(row.length).toBeLessThan(60);
    }
  });

  it("strips a newline out of a scenario name rather than gaining a row", () => {
    // Scenario names are user config. A newline in one adds a physical row the redraw does not
    // know about, and one line of debris climbs the terminal on every frame.
    const written: string[] = [];
    const dashboard = createDashboard({ write: (t) => written.push(t), columns: 120 });

    dashboard.update(summaryOf(scenario({ name: "reads\nINJECTED" })));

    expect(rowsOf(written)).toHaveLength(frameFor(summaryOf(scenario())).length);
  });

  it("draws a usable frame when the terminal reports no width at all", () => {
    // A pty with no window size reports 0, and some report undefined. Both drew a garbage frame —
    // one character per row, or five blank rows — for the whole run.
    for (const columns of [0, undefined]) {
      const written: string[] = [];
      const dashboard = createDashboard({ write: (t) => written.push(t), columns });

      dashboard.update(summaryOf(scenario()));

      for (const row of rowsOf(written)) {
        expect(row.trim().length).toBeGreaterThan(1);
      }
    }
  });
});

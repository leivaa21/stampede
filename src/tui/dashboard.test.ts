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
  responseCount: 38,
  errorCount: 0,
  abandonedCount: 0,
  requestedRatePerSecond: 100,
  achievedRatePerSecond: 96,
  latencyMs: latency(),
  scheduledLatencyMs: latency({ p99Ms: 64 }),
  scheduleLagMs: undefined,
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

  it("says nothing about shortfalls when there are none", () => {
    expect(frameFor(summaryOf(scenario())).join("\n")).not.toContain("⚠");
  });

  it("shows achieved against requested, rounded the honest way", () => {
    const frame = frameFor(
      summaryOf(scenario({ requestedRatePerSecond: 100, achievedRatePerSecond: 96.7 })),
    ).join("\n");

    expect(frame).toContain("100/s asked · 96/s achieved");
  });

  it("shows the queued percentile beside the raw one", () => {
    // The gap between them is the coordinated-omission story; a live view showing only the flattering
    // one would be the wrong half.
    const frame = frameFor(summaryOf(scenario())).join("\n");

    expect(frame).toContain("p99 16.0ms · queued p99 64.0ms");
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

  it("truncates to the terminal width rather than wrapping", () => {
    // A wrapped line takes two rows, so the next redraw would move up by fewer rows than it printed.
    const { dashboard, text } = collect();
    const narrow = createDashboard({ write: (t) => text().concat(t), columns: 20 });

    expect(() => {
      narrow.update(summaryOf(scenario({ name: "a-very-long-scenario-name-indeed" })));
    }).not.toThrow();
    dashboard.stop();
  });

  it("keeps every line inside the given width", () => {
    const written: string[] = [];
    const narrow = createDashboard({ write: (t) => written.push(t), columns: 30 });

    narrow.update(summaryOf(scenario({ name: "an-extremely-long-scenario-name-here" })));

    const drawn = written
      .join("")
      .split("\n")
      // eslint-disable-next-line no-control-regex
      .map((line) => line.replace(/\[[0-9?]*[A-Za-z]/g, ""))
      .filter((line) => line.length > 0);
    for (const line of drawn) {
      expect(line.length).toBeLessThanOrEqual(29);
    }
  });
});

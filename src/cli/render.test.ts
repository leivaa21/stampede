import { describe, expect, it } from "vitest";
import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import { renderSummary, renderVerdict } from "./render.ts";

/**
 * The only user-facing output in the tool, and the place every honesty rule in this milestone
 * finally has to show up as text.
 *
 * Worth testing precisely because it is "just formatting": a rounding that hides a 20 % shortfall
 * and a missing overflow warning are both invisible to every other test in the repo, and both
 * publish a flattering number.
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
  name: "reads",
  scheduledCount: 10,
  dispatchedCount: 10,
  droppedCount: 0,
  requestErrorCount: 0,
  responseCount: 10,
  errorCount: 0,
  abandonedCount: 0,
  requestedRatePerSecond: 10,
  achievedRatePerSecond: 10,
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
  elapsedMs: 1_000,
  scenarios,
  droppedCount: 0,
  abandonedCount: 0,
  maxObservedInFlight: 40,
});

describe("renderSummary", () => {
  it("prints achieved beside requested so a shortfall cannot hide", () => {
    const text = renderSummary(
      summaryOf(scenario({ requestedRatePerSecond: 1_000, achievedRatePerSecond: 400 })),
    );

    expect(text).toContain("1,000/s requested · 400/s achieved");
  });

  it("never rounds a shortfall away", () => {
    // Math.round on both sides turned a 20% shortfall into "2/s · 2/s". Requested rounds up,
    // achieved rounds down, so the gap can only ever look worse than it was — never better.
    const text = renderSummary(
      summaryOf(scenario({ requestedRatePerSecond: 2, achievedRatePerSecond: 1.6 })),
    );

    expect(text).toContain("2/s requested · 1.6/s achieved");
    expect(text).not.toContain("2/s requested · 2/s achieved");
  });

  it("floors the achieved rate and ceils the requested one above 10/s", () => {
    // The direction only shows up where round and floor disagree: 999.6 achieved must never print
    // as a round 1,000 next to a requested 1,000, because that reads as "kept up exactly".
    const text = renderSummary(
      summaryOf(scenario({ requestedRatePerSecond: 999.4, achievedRatePerSecond: 999.6 })),
    );

    expect(text).toContain("1,000/s requested · 999/s achieved");
  });

  it("does not collapse a sub-1/s achieved rate to zero", () => {
    const text = renderSummary(
      summaryOf(scenario({ requestedRatePerSecond: 0.5, achievedRatePerSecond: 0.4 })),
    );

    expect(text).toContain("0.4/s achieved");
    expect(text).not.toContain("0/s achieved");
  });

  it("says why a burst has no rate rather than printing dashes", () => {
    const text = renderSummary(
      summaryOf(scenario({ requestedRatePerSecond: undefined, achievedRatePerSecond: undefined })),
    );

    expect(text).toContain("a burst asks for a count, not a rate");
  });

  it("warns when the queued distribution was clamped, not just the send-side one", () => {
    // scheduledLatency ≥ latency by construction, so it hits the ceiling FIRST. Warning only about
    // `latency` stays silent on exactly the coordinated-omission run D1-01 was written for.
    const text = renderSummary(
      summaryOf(
        scenario({
          latencyMs: latency(),
          scheduledLatencyMs: latency({
            isLowerBound: true,
            overflowCount: 4_211,
            p99Ms: 67_108.9,
          }),
        }),
      ),
    );

    expect(text).toContain("as queued: 4211 samples exceeded the histogram ceiling");
    expect(text).toContain("lower bounds, not measurements");
  });

  it("warns per distribution, so a clean row is not tarred by a clamped one", () => {
    const text = renderSummary(
      summaryOf(
        scenario({
          latencyMs: latency({ isLowerBound: true, overflowCount: 7 }),
          scheduledLatencyMs: latency(),
        }),
      ),
    );

    expect(text).toContain("latency: 7 samples exceeded");
    expect(text).not.toContain("as queued: ");
  });

  it("says nothing about the ceiling when nothing was clamped", () => {
    expect(renderSummary(summaryOf(scenario()))).not.toContain("histogram ceiling");
  });

  it("shows every shortfall it has, and none it does not", () => {
    const text = renderSummary(
      summaryOf(scenario({ droppedCount: 3, errorCount: 2, abandonedCount: 0 })),
    );

    expect(text).toContain("3 dropped");
    expect(text).toContain("2 failed");
    expect(text).not.toContain("abandoned");
  });

  it("calls peak in flight an upper bound, because that is what it is", () => {
    // worker-pool documents it as a sum of independent per-thread maxima — the peaks need not have
    // coincided, so printing it bare would state something nobody observed.
    expect(renderSummary(summaryOf(scenario()))).toContain("peak in flight ≤ 40");
  });

  it("prints a check even when it passed, so an asserting run does not look like a silent one", () => {
    const text = renderSummary(
      summaryOf(
        scenario({ checks: { oneWinnerOrConflict: { passed: 500, failed: 0, broken: 0 } } }),
      ),
    );

    expect(text).toContain("check       PASS  oneWinnerOrConflict");
  });

  it("shows how many responses failed a check, not just that one did", () => {
    const text = renderSummary(
      summaryOf(scenario({ checks: { noDoubleSell: { passed: 480, failed: 20, broken: 0 } } })),
    );

    expect(text).toContain("FAIL 20/500  noDoubleSell");
  });

  it("prints counters and recorded distributions", () => {
    const text = renderSummary(
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

    expect(text).toContain("counter     reserved201 = 1");
    expect(text).toContain("recorded    behindMs");
  });

  it("never prints PASS for a check that only ever broke", () => {
    // D2-04's whole point, and the cell the argument is written about. Collapsing broken into PASS
    // publishes a green claim nothing verified; collapsing it into FAIL accuses the target of an
    // invariant violation that was a typo in the predicate.
    const text = renderSummary(
      summaryOf(
        scenario({ checks: { oneWinnerOrConflict: { passed: 0, failed: 0, broken: 500 } } }),
      ),
    );

    expect(text).toContain("BROKEN 500  oneWinnerOrConflict");
    expect(text).not.toContain("PASS  oneWinnerOrConflict");
  });

  it("reports a real failure as FAIL, not as broken", () => {
    const text = renderSummary(
      summaryOf(scenario({ checks: { noDoubleSell: { passed: 10, failed: 2, broken: 0 } } })),
    );

    expect(text).toContain("FAIL 2/12  noDoubleSell");
  });

  it("names requests the config could not build, so a shortfall always has a cause", () => {
    const text = renderSummary(
      summaryOf(scenario({ scheduledCount: 100, dispatchedCount: 90, requestErrorCount: 10 })),
    );

    expect(text).toContain("10 not built (request() threw)");
  });

  it("says when recordings were refused, because the missing ones read as zero", () => {
    const text = renderSummary(summaryOf(scenario({ refusedRecordings: 88 })));

    expect(text).toContain("88 recordings refused");
  });

  it("cannot have its own output rewritten by the target", () => {
    // A counter name can be built from response data, so a hostile target controls a string this
    // writes to a CI log. `\r` alone overwrites the line above; an ANSI escape can print a verdict.
    const text = renderSummary(
      summaryOf(scenario({ counters: { "\u001b[2Kfake\rPASS everything": 1 } })),
    );

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
  });

  it("prints a declared key space on one line, keys inline", () => {
    // A declared key space is a *dimension*, and the only reason to declare it is to compare its
    // keys — splitting them across rows buries the comparison.
    const text = renderSummary(
      summaryOf(scenario({ keyedCounters: { byStatus: { "2xx": 40, "5xx": 2, other: 0 } } })),
    );

    expect(text).toContain("keyed       byStatus  2xx 40 · 5xx 2 · other 0");
  });

  it("cannot have a target-chosen key rewrite the terminal", () => {
    const text = renderSummary(
      summaryOf(scenario({ keyedCounters: { "\u001b[2Kfake": { "a\rb": 1 } } })),
    );

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
  });

  it("warns when an assertion is broken rather than the target", () => {
    expect(renderSummary(summaryOf(scenario({ brokenObservations: 4 })))).toContain(
      "4 broken observations",
    );
  });

  it("keeps multiple scenarios separate and named", () => {
    const text = renderSummary(
      summaryOf(scenario({ name: "reads" }), scenario({ name: "writes" })),
    );

    expect(text).toContain("  reads");
    expect(text).toContain("  writes");
  });
});

describe("renderVerdict", () => {
  it("marks a held claim PASS and a violated one FAIL, by name", () => {
    const text = renderVerdict(
      {
        results: [
          { name: "exactly one buyer wins", held: true, error: undefined },
          { name: "p99 under 250ms", held: false, error: undefined },
        ],
        violated: ["p99 under 250ms"],
        broken: [],
      },
      false,
    );

    expect(text).toContain("PASS    exactly one buyer wins");
    expect(text).toContain("FAIL    p99 under 250ms");
  });

  it("distinguishes a broken predicate from a failed one", () => {
    const text = renderVerdict(
      {
        results: [
          { name: "reaches into nothing", held: false, error: "cannot read x of undefined" },
        ],
        violated: [],
        broken: ["reaches into nothing"],
      },
      false,
    );

    expect(text).toContain("BROKEN  reaches into nothing");
    expect(text).toContain("cannot read x of undefined");
    expect(text).not.toContain("FAIL");
  });

  it("says plainly when a run asserted nothing at all", () => {
    expect(renderVerdict({ results: [], violated: [], broken: [] }, false)).toContain(
      "nothing was asserted",
    );
  });

  it("says nothing about thresholds when the run already failed for another reason", () => {
    // The round-three defect, on the surface it originally shipped on: "nothing was asserted about
    // this run" printed one line above "teardown() failed — double sell: 2 sold" is the same false
    // reassurance the report refuses to publish. An empty verdict is what a run that declared no
    // thresholds now carries — thresholds are evaluated even after a teardown failure.
    expect(renderVerdict({ results: [], violated: [], broken: [] }, true)).toBe("");
  });

  it("still says so when nothing went wrong and nothing was asserted", () => {
    // The other half: a clean run that declared no thresholds must not look like a proven one.
    expect(renderVerdict({ results: [], violated: [], broken: [] }, false)).toContain(
      "nothing was asserted about this run",
    );
  });

  it("cannot have a threshold's own error rewrite the terminal", () => {
    // `throw new Error(await res.text())` in a teardown or a predicate is ordinary, and it puts
    // target-chosen bytes straight into a CI log.
    const text = renderVerdict(
      {
        results: [{ name: "claim", held: false, error: "\u001b[2Kfake\rPASS" }],
        violated: [],
        broken: ["claim"],
      },
      false,
    );

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
  });
});

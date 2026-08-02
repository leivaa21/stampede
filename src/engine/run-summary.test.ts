import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../metrics/index.ts";
import { brokenCheckCounter, EngineMetric } from "./metric-names.ts";
import { summariseRun, type RunProgress } from "./run-summary.ts";

/**
 * The projection every published number passes through.
 *
 * Everything else in `engine/` tests the summary end to end, by running a dispatch loop — which is
 * the right way to test a dispatch loop and the wrong way to test this: it can only reach the
 * combinations a real run happens to produce, and the interesting cases here are the ones a real
 * run produces rarely (a check that only ever broke, a counter in the engine's namespace, a
 * scenario the metrics registry never heard of). Written straight into the registry, those are one
 * line each.
 */

const progressFor = (
  scenarios: readonly { name: string; scheduledCount: number; durationMs: number }[],
): RunProgress => ({
  elapsedMs: 1_000,
  maxObservedInFlight: 4,
  scenarios: scenarios.map((s) => ({
    name: s.name,
    scheduledCount: s.scheduledCount,
    requestedDurationMs: s.durationMs,
    lastDispatchElapsedMs: s.durationMs,
  })),
});

const oneScenario = progressFor([{ name: "reads", scheduledCount: 10, durationMs: 1_000 }]);

describe("summariseRun separates the user's metrics from the engine's", () => {
  it("publishes the user's counters and hides the engine's own", () => {
    const metrics = new MetricsRegistry();
    const reads = metrics.scenario("reads");
    reads.counters.inc(EngineMetric.dispatched, 10);
    reads.counters.inc(EngineMetric.dropped, 3);
    reads.counters.inc("reserved201", 7);

    const [summary] = summariseRun(oneScenario, metrics).scenarios;

    // The engine's counters have named fields; leaking them into the map as well would print
    // `stampede.dropped = 3` under a heading that says these are the scenario's own.
    expect(summary?.counters).toEqual({ reserved201: 7 });
    expect(summary?.droppedCount).toBe(3);
  });

  it("keeps a check that only ever broke, rather than dropping it from the report", () => {
    const metrics = new MetricsRegistry();
    const reads = metrics.scenario("reads");
    // A check whose predicate threw on every single response has no pass/fail tally at all. Read
    // from `checks` alone it does not exist — and the check a reader most needs named would be the
    // one silently missing from the table.
    reads.counters.inc(EngineMetric.brokenChecks, 10);
    reads.counters.inc(brokenCheckCounter("oneWinner"), 10);

    const [summary] = summariseRun(oneScenario, metrics).scenarios;

    expect(summary?.checks).toEqual({ oneWinner: { passed: 0, failed: 0, broken: 10 } });
    expect(summary?.brokenObservations).toBe(10);
  });

  it("carries broken alongside a check's real pass and fail counts", () => {
    const metrics = new MetricsRegistry();
    const reads = metrics.scenario("reads");
    reads.checks.record("oneWinner", true);
    reads.checks.record("oneWinner", false);
    reads.counters.inc(brokenCheckCounter("oneWinner"), 2);
    reads.counters.inc(EngineMetric.brokenChecks, 2);

    const [summary] = summariseRun(oneScenario, metrics).scenarios;

    // Three states, not two: the failure and the broken predicate are different facts about the
    // same claim, and collapsing them accuses the target of the second one (D2-04).
    expect(summary?.checks.oneWinner).toEqual({ passed: 1, failed: 1, broken: 2 });
  });

  it("orders checks by name, so two workers finishing in either order publish the same table", () => {
    const metrics = new MetricsRegistry();
    const reads = metrics.scenario("reads");
    // Recorded in an order no reader would choose. Map iteration would preserve it, and a report
    // whose rows move when a worker finishes sooner is not a reproducible report (D1-02).
    for (const name of ["zeta", "alpha", "mid"]) {
      reads.checks.record(name, true);
    }

    const [summary] = summariseRun(oneScenario, metrics).scenarios;

    expect(Object.keys(summary?.checks ?? {})).toEqual(["alpha", "mid", "zeta"]);
  });

  it("counts a refused reserved name as a broken observation", () => {
    const metrics = new MetricsRegistry();
    metrics.scenario("reads").counters.inc(EngineMetric.reservedNameRefusals, 5);

    const [summary] = summariseRun(oneScenario, metrics).scenarios;

    // `record.count("stampede.dropped")` is refused at runtime rather than thrown, so without this
    // the run would exit 0 having silently discarded five counts the config asked for.
    expect(summary?.brokenObservations).toBe(5);
    expect(summary?.counters).toEqual({});
  });
});

describe("summariseRun reports what a scenario did, not what it hoped", () => {
  it("leaves out a check that was declared but never asked", () => {
    const metrics = new MetricsRegistry();
    // The engine reserves a broken-counter slot per declared check before the run starts, so the
    // counter map knows the name even when no response ever reached the predicate. Publishing it
    // as `{ passed: 0, failed: 0, broken: 0 }` would render **PASS** — a green claim about
    // responses that do not exist.
    metrics.scenario("reads").counters.reserve(brokenCheckCounter("neverRan"));

    const [summary] = summariseRun(oneScenario, metrics).scenarios;

    expect(summary?.checks).toEqual({});
  });

  it("publishes zeros for a scenario the registry never heard of", () => {
    // A worker that died before its first response sends no namespace for its scenario. The
    // scenario still has to appear, at zero — a run that quietly drops a scenario from its report
    // is a run whose thresholds have nothing to fail against.
    const [summary] = summariseRun(oneScenario, new MetricsRegistry()).scenarios;

    expect(summary?.name).toBe("reads");
    expect(summary?.scheduledCount).toBe(10);
    expect(summary?.dispatchedCount).toBe(0);
    expect(summary?.requestErrorCount).toBe(0);
    expect(summary?.latencyMs).toBeUndefined();
    expect(summary?.checks).toEqual({});
  });

  it("divides the achieved rate by the time the run really took", () => {
    const metrics = new MetricsRegistry();
    metrics.scenario("reads").counters.inc(EngineMetric.dispatched, 500);

    // Asked for 500 over 1 s; took 2 s to issue them. Dividing by the requested span would report
    // 500/s achieved — a generator that fell behind claiming it kept up (D1-01).
    const progress: RunProgress = {
      elapsedMs: 2_000,
      maxObservedInFlight: 500,
      scenarios: [
        {
          name: "reads",
          scheduledCount: 500,
          requestedDurationMs: 1_000,
          lastDispatchElapsedMs: 2_000,
        },
      ],
    };
    const [summary] = summariseRun(progress, metrics).scenarios;

    expect(summary?.requestedRatePerSecond).toBe(500);
    expect(summary?.achievedRatePerSecond).toBe(250);
  });
});

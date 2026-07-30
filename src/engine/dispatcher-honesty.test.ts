import { describe, expect, it } from "vitest";
import {
  expectMs,
  runToCompletion,
  scenario,
  summaryOf,
} from "../test-support/dispatch-fixtures.ts";
import { FakeClock } from "../test-support/fake-clock.ts";
import { FakeTransport, synchronouslyThrowingTransport } from "../test-support/fake-transport.ts";
import { burst, constantRate } from "./arrival-profiles.ts";
import { EngineMetric } from "./metric-names.ts";

/**
 * The guards that make this a measuring instrument rather than a benchmark generator.
 *
 * Every test here is a claim the tool makes about itself when it is *not* keeping up: that the
 * time it spent backed up lands in the number a user would have experienced, that requests it
 * refused to send are counted rather than absorbed, and that the rate it reports achieving is the
 * one it achieved. A load tester which quietly lowers its own rate and then publishes the
 * resulting p99 is the failure mode D1-01 exists to prevent, and these are the tests that would
 * catch stampede doing it.
 */

describe("scheduledLatency carries the generator's own backlog", () => {
  it("includes injected lag, while latency does not — the coordinated-omission test", async () => {
    const clock = new FakeClock();
    // A target that answers instantly, so every millisecond of delay in the numbers below can only
    // have come from the generator.
    const transport = new FakeTransport({ clock });
    // The dispatcher's first wait comes back 500 ms late: the loop was busy elsewhere, exactly as a
    // real one is when a GC pause or a saturated event loop lands mid-run.
    clock.oversleepNext(500);

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    // The target really did take no time at all, and the tool says so.
    expect(reads.latencyMs?.maxMs).toBe(0);
    // The requests scheduled for 100…500 ms all went out at 500 ms, so the user who asked at
    // 100 ms waited 400 ms. A closed-loop generator would have reported the 0 ms and stopped there.
    expectMs(reads.scheduledLatencyMs?.maxMs, 400);
    expectMs(reads.scheduleLagMs?.maxMs, 400);
    // Nothing was dropped or moved to make that number look better: all ten still went out.
    expect(reads.dispatchedCount).toBe(10);
    expect(reads.droppedCount).toBe(0);
    expect(transport.sentAtMs()).toEqual([0, 500, 500, 500, 500, 500, 600, 700, 800, 900]);
  });

  it("reports an achieved rate below the requested one when it cannot keep up", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });
    // Twice the profile's whole duration, so every remaining instant comes due at once, late.
    clock.oversleepNext(2_000);

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    // Ten requests over the two seconds it really took, not over the one second it asked for.
    expect(reads.requestedRatePerSecond).toBe(10);
    expect(reads.achievedRatePerSecond).toBe(5);
    expect(reads.dispatchedCount).toBe(10);
    expectMs(reads.scheduleLagMs?.maxMs, 1_900);
  });
});

describe("the in-flight cap drops requests and counts every one of them", () => {
  it("stops dispatching at the cap and reports the drops in the summary", async () => {
    const clock = new FakeClock();
    // A target that accepts everything and answers nothing — the unbounded-memory case the cap is
    // for.
    const transport = new FakeTransport({ clock, hangs: true });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 3,
        drainTimeoutMs: 50,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.dispatchedCount).toBe(3);
    expect(reads.droppedCount).toBe(7);
    expect(outcome.summary.droppedCount).toBe(7);
    expect(outcome.summary.maxObservedInFlight).toBe(3);
    // The drops are in the achieved rate too, so the two numbers cannot tell different stories.
    expect(reads.requestedRatePerSecond).toBe(10);
    expect(reads.achievedRatePerSecond).toBe(3);
    expect(reads.responseCount).toBe(0);
    expect(reads.latencyMs).toBeUndefined();
  });

  it("attributes drops to the scenario that took the slot and to the one that lost it", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, hangs: true });

    // Both bursts want the same instant; the cap is a run-level resource, so the scenario listed
    // first takes the slots and the second is the one that goes without.
    const outcome = await runToCompletion(
      {
        scenarios: [
          scenario("reads", burst({ count: 10 })),
          scenario("writes", burst({ count: 10 })),
        ],
        maxInFlight: 5,
        drainTimeoutMs: 0,
      },
      clock,
      transport,
    );

    expect(summaryOf(outcome, "reads").dispatchedCount).toBe(5);
    expect(summaryOf(outcome, "reads").droppedCount).toBe(5);
    expect(summaryOf(outcome, "writes").dispatchedCount).toBe(0);
    expect(summaryOf(outcome, "writes").droppedCount).toBe(10);
    expect(outcome.summary.droppedCount).toBe(15);
  });
});

describe("one bad request cannot cost the whole run", () => {
  it("counts a transport that throws synchronously instead of dying with no report", async () => {
    const clock = new FakeClock();

    // `ports.ts` requires `send` to reject, but a port is inbound data and nothing enforces it. A
    // real transport throws synchronously for ordinary reasons — `new URL()` on a malformed
    // target, body serialisation, a bad header. Thrown from inside the dispatch loop, that used to
    // escape `runDispatch` entirely: no drain, no summary, twenty minutes of load unpublished.
    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", burst({ count: 5 }))],
        maxInFlight: 10,
        drainTimeoutMs: 0,
      },
      clock,
      synchronouslyThrowingTransport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.dispatchedCount).toBe(5);
    expect(reads.errorCount).toBe(5);
    expect(reads.responseCount).toBe(0);
    // Counted like any other transport failure, and kept out of the percentiles.
    expect(reads.latencyMs).toBeUndefined();
  });
});

describe("the accounting adds up", () => {
  it("keeps both identities across a mixed run under a binding cap", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 300 });

    const outcome = await runToCompletion(
      {
        scenarios: [
          scenario("burst", burst({ count: 20 })),
          scenario("steady", constantRate({ ratePerSecond: 20, durationMs: 1_000 })),
        ],
        maxInFlight: 12,
        drainTimeoutMs: 1_000,
      },
      clock,
      transport,
    );

    // The two sentences the README will claim. Nothing is invented and nothing evaporates:
    // every instant the profile asked for was either sent or refused, and every request that
    // went out either answered, failed, or was abandoned at the deadline.
    for (const s of outcome.summary.scenarios) {
      expect(s.dispatchedCount + s.droppedCount).toBe(s.scheduledCount);
      expect(s.responseCount + s.errorCount + s.abandonedCount).toBe(s.dispatchedCount);
    }
    expect(outcome.summary.maxObservedInFlight).toBeLessThanOrEqual(12);
  });

  it("hands out a frozen summary, all the way down", () => {
    // `metrics/` freezes its summaries and asserts it; this file's docstring claims the same and
    // did not. A reporter and a threshold predicate both receive this object, and neither should
    // be able to edit the record before the other reads it.
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });

    return runToCompletion(
      { scenarios: [scenario("reads", burst({ count: 2 }))], maxInFlight: 5 },
      clock,
      transport,
    ).then((outcome) => {
      expect(Object.isFrozen(outcome.summary)).toBe(true);
      expect(Object.isFrozen(outcome.summary.scenarios)).toBe(true);
      expect(Object.isFrozen(outcome.summary.scenarios[0])).toBe(true);
      expect(Object.isFrozen(outcome.summary.scenarios[0]?.latencyMs)).toBe(true);
    });
  });
});

describe("what never came back is counted, never guessed at", () => {
  it("counts a refused connection without letting it into the latency percentiles", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, fails: true });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.dispatchedCount).toBe(10);
    expect(reads.errorCount).toBe(10);
    expect(reads.responseCount).toBe(0);
    // An instant connection refusal recorded as a 0.1 ms latency would be the most flattering p99
    // a broken target could produce. A run with no responses at all is a failed run (D1-06), and
    // the missing summary is what lets a later PR say so.
    expect(reads.latencyMs).toBeUndefined();
    expect(reads.scheduledLatencyMs).toBeUndefined();
  });

  it("abandons what is still outstanding at the drain deadline, and counts it", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 200 });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", burst({ count: 3 }))],
        maxInFlight: 10,
        drainTimeoutMs: 0,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.abandonedCount).toBe(3);
    expect(outcome.summary.abandonedCount).toBe(3);
    expect(reads.responseCount).toBe(0);
    // The clock ran on to 200 ms inside `runToCompletion`, so those three responses have since
    // landed. They are not recorded: the run already published its numbers, and a percentile that
    // keeps moving after the report was written is worse than a sample that is honestly missing.
    expect(outcome.metrics.scenario("reads").findHistogram(EngineMetric.latency)).toBeUndefined();
  });

  it("waits out the drain for responses that arrive in time", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 20 });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", burst({ count: 3 }))],
        maxInFlight: 10,
        drainTimeoutMs: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.responseCount).toBe(3);
    expect(reads.abandonedCount).toBe(0);
    expectMs(reads.latencyMs?.maxMs, 20);
  });
});

import { describe, expect, it } from "vitest";
import {
  expectMs,
  runToCompletion,
  scenario,
  summaryOf,
} from "../test-support/dispatch-fixtures.ts";
import { FakeClock } from "../test-support/fake-clock.ts";
import {
  FakeTransport,
  synchronouslyThrowingTransport,
  type FakeRequest,
} from "../test-support/fake-transport.ts";
import { burst, constantRate } from "./arrival-profiles.ts";
import type { Transport, TransportResponse } from "./ports.ts";

import { MAX_DISTINCT_TALLIES } from "../metrics/validate.ts";
import { EngineMetric, ENGINE_COUNTERS } from "./metric-names.ts";
/** The reference target's answer, when it is answering. */
const okResponse = (): TransportResponse => ({
  status: 200,
  headers: {},
  text: JSON.stringify({ ok: true }),
});

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

describe("user code cannot starve the engine's own bookkeeping", () => {
  /**
   * The counter map is bounded, and `record.count(`seat-${id}`)` — contract run 2's own shape —
   * reaches that bound legitimately. Engine counters are created lazily on their first increment,
   * so before the engine reserved its names, whatever had not yet fired by then was refused.
   *
   * **The ordering is the whole test.** A burst whose dispatches all happen before any response
   * cannot show this: `dispatched` and `requestErrors` claim their slots in that first batch, and
   * the check loop claims `brokenChecks` before `onResponse` writes its first name. The counters
   * that actually starve are the ones whose first increment arrives *after* user code has filled
   * the map — drops, abandonment, transport errors, and a check that starts breaking late. So the
   * target here answers a few hundred requests instantly, and only then stops answering at all.
   */
  it("keeps counting drops and abandonment after a user has filled the name budget", async () => {
    const clock = new FakeClock();
    let answered = 0;
    // Answers the first 600 instantly, then never again — a target that falls over mid-run.
    // 600 is above the 512-name cap on purpose: the map has to be full before the first drop.
    const transport: Transport<FakeRequest> = {
      send: () => {
        answered += 1;
        return answered <= 600 ? Promise.resolve(okResponse()) : new Promise(() => undefined);
      },
    };

    let names = 0;
    const outcome = await runToCompletion(
      {
        scenarios: [
          {
            name: "reads",
            profile: constantRate({ ratePerSecond: 1_000, durationMs: 1_000 }),
            requestFor: () => ({ label: "reads" }),
            checks: {
              // Sound until the target stops answering, then broken on every response after —
              // a JSON check meeting an HTML 503 page. Its per-name counter is claimed on the
              // first *breakage*, which is deliberately after the map is full.
              parsesBody: (response) => (JSON.parse(response.text) as { ok: boolean }).ok,
            },
            // One name per response: 600 distinct names against a 512-name cap, every slot taken
            // before the first drop happens.
            onResponse: (_response, record) => {
              names += 1;
              record.count(`seat-${String(names)}`);
            },
          },
        ],
        maxInFlight: 50,
        drainTimeoutMs: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    // The counters that only exist because the target fell over. Without reservation these are
    // refused and the run reports a clean sweep of a thousand requests it never completed.
    expect(reads.droppedCount).toBeGreaterThan(0);
    expect(reads.abandonedCount).toBeGreaterThan(0);
    expect(reads.dispatchedCount + reads.droppedCount + reads.requestErrorCount).toBe(
      reads.scheduledCount,
    );
    expect(reads.responseCount + reads.errorCount + reads.abandonedCount).toBe(
      reads.dispatchedCount,
    );
    // And the refusals themselves are published rather than absorbed. Derived from the constants
    // rather than written out: hardcoding it made this test the thing that broke when a metric was
    // added, which says nothing about the behaviour under test.
    const reservedByTheEngine = ENGINE_COUNTERS.length + 1; // + the one declared check
    expect(reads.refusedRecordings).toBe(600 - (MAX_DISTINCT_TALLIES - reservedByTheEngine));
  });

  it("keeps counting a declared key that first fires after the budget is full", async () => {
    // The mechanism D25-01's whole argument rests on: every declared slot is reserved before the
    // run, exactly like the engine's own counters. Without the reservation the declared slot is
    // refused once user names fill the map, and `keyedCountersOf`'s `?? 0` then publishes a
    // confident zero for a key that really was incremented — a number nobody would question.
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });

    let names = 0;
    const outcome = await runToCompletion(
      {
        scenarios: [
          {
            name: "reads",
            profile: burst({ count: 700 }),
            requestFor: () => ({ label: "reads" }),
            keyedCounters: { byOutcome: ["late"] },
            onResponse: (_response, record) => {
              names += 1;
              // 600 distinct names first — past the 512 cap — and only then the declared key.
              if (names <= 600) {
                record.count(`seat-${String(names)}`);
                return;
              }
              record.countKeyed("byOutcome", "late");
            },
          },
        ],
        maxInFlight: 1_000,
        drainTimeoutMs: 1_000,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.responseCount).toBe(700);
    expect(reads.keyedCounters.byOutcome).toEqual({ late: 100, other: 0 });
  });

  it("keeps attributing a check that only starts breaking once the budget is full", async () => {
    const clock = new FakeClock();
    let answered = 0;
    const transport: Transport<FakeRequest> = {
      send: () => {
        answered += 1;
        return Promise.resolve(
          answered <= 600 ? okResponse() : { ...okResponse(), text: "<html>" },
        );
      },
    };

    let names = 0;
    const outcome = await runToCompletion(
      {
        scenarios: [
          {
            name: "reads",
            profile: constantRate({ ratePerSecond: 1_000, durationMs: 1_000 }),
            requestFor: () => ({ label: "reads" }),
            checks: { parsesBody: (response) => (JSON.parse(response.text) as { ok: boolean }).ok },
            onResponse: (_response, record) => {
              names += 1;
              record.count(`seat-${String(names)}`);
            },
          },
        ],
        maxInFlight: 1_000,
        drainTimeoutMs: 500,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    // 600 good responses fill the map; every one after breaks the predicate. Losing the per-name
    // counter here publishes `PASS parsesBody 600 / 0 / 0` for a run in which 400 responses broke
    // it outright — and losing the total publishes exit 0 for the same run.
    // Pinned against a constant, not against `responseCount`: `expect(x).toBe(responseCount - 600)`
    // decays into `expect(0).toBe(0)` the day a tighter drain lets fewer than 600 responses land.
    expect(reads.responseCount).toBe(1_000);
    expect(reads.checks.parsesBody?.passed).toBe(600);
    expect(reads.checks.parsesBody?.broken).toBe(400);
    expect(reads.brokenObservations).toBe(400);
  });
});

describe("user code on the response path cannot bend the numbers", () => {
  it("measures latency before running the scenario's checks", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 40 });

    const outcome = await runToCompletion(
      {
        scenarios: [
          {
            // One request, so the claim under test is the ordering *within* one response. With
            // several in flight the check's 60 ms would also delay the next response's callback —
            // which is real, and honestly reported, but a different fact.
            ...scenario("reads", burst({ count: 1 })),
            // 60 ms of the user's own CPU per response — `JSON.parse` on a large body is the
            // realistic version. Half again as long as the target took, so if it landed in the
            // measurement the test could not miss it.
            checks: {
              slow: () => {
                clock.burn(60);
                return true;
              },
            },
          },
        ],
        maxInFlight: 10,
        drainTimeoutMs: 500,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    // The target took 40 ms and the report says 40 ms. Observing before recording would publish
    // 100 ms — a target blamed for time the assertion spent, in a tool whose pitch is honest
    // numbers. Checks still all ran.
    expectMs(reads.latencyMs?.maxMs, 40);
    expect(reads.checks.slow).toEqual({ passed: 1, failed: 0, broken: 0 });
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
      expect(s.dispatchedCount + s.droppedCount + s.requestErrorCount).toBe(s.scheduledCount);
      expect(s.responseCount + s.errorCount + s.abandonedCount).toBe(s.dispatchedCount);
    }
    expect(outcome.summary.maxObservedInFlight).toBeLessThanOrEqual(12);
  });

  it("keeps the first identity true when request() itself is what failed", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });

    const outcome = await runToCompletion(
      {
        scenarios: [
          {
            name: "reads",
            profile: burst({ count: 10 }),
            // Every third seat is missing from the pool `setup()` built — an ordinary config bug.
            requestFor: (ordinal) => {
              if (ordinal % 3 === 0) {
                throw new Error("no seat for that ordinal");
              }
              return { label: "reads" };
            },
          },
        ],
        maxInFlight: 50,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    // Counted apart from `errorCount`, deliberately: nothing was sent, so the target cannot be
    // what went wrong. Folding these into transport errors would send the reader to inspect a
    // server that was never asked, and reading them as drops would blame `maxInFlight`.
    expect(reads.requestErrorCount).toBe(4);
    expect(reads.errorCount).toBe(0);
    expect(reads.droppedCount).toBe(0);
    expect(reads.dispatchedCount).toBe(6);
    expect(transport.sentCount).toBe(6);
    expect(reads.dispatchedCount + reads.droppedCount + reads.requestErrorCount).toBe(
      reads.scheduledCount,
    );
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
      // The maps built fresh per summary are the easiest ones to leave thawed, and they are the
      // ones a threshold predicate reaches into by name.
      expect(Object.isFrozen(outcome.summary.scenarios[0]?.counters)).toBe(true);
      expect(Object.isFrozen(outcome.summary.scenarios[0]?.checks)).toBe(true);
      expect(Object.isFrozen(outcome.summary.scenarios[0]?.trends)).toBe(true);
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
    // And neither are their checks. A check recorded against a response the run refused to time
    // would put a claim in the report that no published number covers.
    expect(reads.checks).toEqual({});
  });

  it("does not run a scenario's checks against responses that arrived too late", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 200 });

    const outcome = await runToCompletion(
      {
        scenarios: [
          {
            ...scenario("reads", burst({ count: 3 })),
            checks: { answered: () => true },
          },
        ],
        maxInFlight: 10,
        drainTimeoutMs: 0,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.abandonedCount).toBe(3);
    // Three responses did eventually land, and a check that ran on them would report
    // "PASS answered 3/3" for a run whose own summary says nothing came back in time.
    expect(reads.checks.answered).toBeUndefined();
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

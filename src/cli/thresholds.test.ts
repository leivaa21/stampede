import { describe, expect, it } from "vitest";
import type { RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import {
  evaluateThresholds,
  findBrokenObservations,
  findImpureRequests,
  findLostSchedule,
  findRefusedRecordings,
  findUnmeasuredScenario,
} from "./thresholds.ts";

const scenario = (over: Partial<ScenarioRunSummary> = {}): ScenarioRunSummary => ({
  name: "reads",
  scheduledCount: 10,
  dispatchedCount: 10,
  droppedCount: 0,
  requestErrorCount: 0,
  impureRequestCount: 0,
  responseCount: 10,
  errorCount: 0,
  abandonedCount: 0,
  requestedRatePerSecond: 10,
  achievedRatePerSecond: 10,
  latencyMs: undefined,
  scheduledLatencyMs: undefined,
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
  maxObservedInFlight: 1,
});

describe("findUnmeasuredScenario", () => {
  it("passes a scenario that recorded responses", () => {
    expect(findUnmeasuredScenario(summaryOf(scenario()))).toBeUndefined();
  });

  it("catches a scenario where everything failed", () => {
    // The unreachable-target case. Without this the run would reach the thresholds with no
    // percentiles at all, and the obvious `(s.p99 ?? 0) < 250` would *pass* — a scenario that never
    // ran clearing its own threshold, which is the exact lie D1-02's `undefined` exists to prevent.
    const message = findUnmeasuredScenario(
      summaryOf(scenario({ responseCount: 0, errorCount: 10 })),
    );

    expect(message).toContain('"reads"');
    expect(message).toContain("10 failed");
    expect(message).toContain("target is reachable");
  });

  it("catches a scenario where everything was dropped", () => {
    expect(
      findUnmeasuredScenario(
        summaryOf(scenario({ responseCount: 0, dispatchedCount: 0, droppedCount: 10 })),
      ),
    ).toContain("10 dropped");
  });

  it("ignores a scenario that never scheduled anything", () => {
    // A profile of zero requests measured nothing, but nothing was asked of it either.
    expect(
      findUnmeasuredScenario(summaryOf(scenario({ scheduledCount: 0, responseCount: 0 }))),
    ).toBeUndefined();
  });

  it("blames request(), not the target, when the config could not build anything", () => {
    // "check the target is reachable" for a `request()` that threw on every ordinal sends someone
    // to inspect a server that was never asked. Nothing was sent; the config is the only suspect.
    expect(
      findUnmeasuredScenario(
        summaryOf(
          scenario({
            scheduledCount: 10,
            dispatchedCount: 0,
            responseCount: 0,
            requestErrorCount: 10,
          }),
        ),
      ),
    ).toContain("fix `request()` in the config");
  });

  it("does not blame request() when only a few builds failed", () => {
    // The boundary matters in both directions: one failed build in a million must not print
    // "every request threw while being built", which would be flatly false.
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 1_000,
          dispatchedCount: 999,
          responseCount: 0,
          errorCount: 999,
          requestErrorCount: 1,
        }),
      ),
    );

    expect(message).toContain("target is reachable");
    expect(message).not.toContain("fix `request()`");
  });

  it("names the first broken scenario when several ran", () => {
    expect(
      findUnmeasuredScenario(
        summaryOf(scenario({ name: "writes", responseCount: 0, errorCount: 10 }), scenario()),
      ),
    ).toContain('"writes"');
  });
});

describe("adviceFor, through the message that carries it", () => {
  it("blames the builder when most of the attempted instants never became a request", () => {
    // Judged as a family. Compared separately against the schedule, 5 impure + 5 thrown + 1 sent
    // satisfied neither cause and fell through to "check the target is reachable" — sending
    // someone to inspect a server that had been asked once out of eleven.
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 11,
          dispatchedCount: 1,
          impureRequestCount: 5,
          requestErrorCount: 5,
          responseCount: 0,
        }),
      ),
    );

    expect(message).toContain("mutated the setup state, which is guarded");
    expect(message).not.toContain("check the target is reachable");
  });

  it("keeps the purity remedy reachable on the path that returns before the finder runs", () => {
    // `findUnmeasuredScenario` returns first, so `findImpureRequests` never runs on a scenario
    // that recorded nothing. This sentence is the only place the remedy reaches that reader.
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 4,
          dispatchedCount: 0,
          impureRequestCount: 4,
          responseCount: 0,
        }),
      ),
    );

    expect(message).toContain("seats[ordinal % seats.length]");
    // The term itself, not only the remedy: this line is the one place a reader of an unmeasured
    // scenario can see where the schedule went.
    expect(message).toContain("4 impure");
  });

  it("still blames the cap when the drops, not the builder, are the story", () => {
    // Set up as the title promises: drops dominate *and* the builder failed more often than
    // anything was dispatched. Under a binding cap `dispatched` sits at `maxInFlight`, so a family
    // threshold that only had to beat the dispatches claimed this run for `request()` — telling
    // someone whose target is slow and whose cap is tight to go fix their config.
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 1000,
          dispatchedCount: 10,
          droppedCount: 970,
          requestErrorCount: 20,
          responseCount: 0,
        }),
      ),
    );

    expect(message).toContain("maxInFlight");
    expect(message).not.toContain("fix `request()` in the config");
  });

  it("says the purity contract even when the drops won the diagnosis", () => {
    // The shortfall line the reader is looking at says `1 not built (impure request())`, and that
    // phrase does not define itself. Losing it to a branch it did not win leaves the page naming a
    // failure it never explains, with the advice pointing at the network.
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 1000,
          dispatchedCount: 999,
          errorCount: 999,
          impureRequestCount: 1,
          responseCount: 0,
        }),
      ),
    );

    expect(message).toContain("1 request could not be built");
    expect(message).toContain("seats[ordinal % seats.length]");
  });

  it("says nothing about purity when there was none, however the run failed", () => {
    // Without the zero guard this emits "Separately, 0 requests could not be built at all" on
    // every dropped-out run in the tool.
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({ scheduledCount: 10, dispatchedCount: 0, droppedCount: 10, responseCount: 0 }),
      ),
    );

    expect(message).not.toContain("Separately");
  });

  it("counts in the plural when more than one request could not be built", () => {
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 1000,
          dispatchedCount: 997,
          errorCount: 997,
          impureRequestCount: 3,
          responseCount: 0,
        }),
      ),
    );

    expect(message).toContain("3 requests could not be built");
  });

  it("does not say the purity contract twice when purity is the dominant cause", () => {
    const message = findUnmeasuredScenario(
      summaryOf(
        scenario({
          scheduledCount: 4,
          dispatchedCount: 0,
          impureRequestCount: 4,
          responseCount: 0,
        }),
      ),
    );

    expect(message?.match(/mutated the setup state, which is guarded/g)).toHaveLength(1);
  });
});

describe("findRefusedRecordings", () => {
  it("says nothing when every recording was accepted", () => {
    expect(findRefusedRecordings(summaryOf(scenario()))).toBeUndefined();
  });

  it("fails the run when names were refused, because the missing ones read as zero", () => {
    // `metrics/validate.ts`: a refusal nobody counts is a silent hole in the numbers. A threshold
    // reading a counter that never got a slot reads a confident 0 and reports a violation the
    // target never caused.
    const message = findRefusedRecordings(summaryOf(scenario({ refusedRecordings: 88 })));

    expect(message).toContain('"reads"');
    expect(message).toContain("88 recordings");
    expect(message).toContain("cardinality bomb");
  });
});

describe("findImpureRequests", () => {
  it("says nothing about a run whose builder behaved", () => {
    expect(findImpureRequests(summaryOf(scenario()))).toBeUndefined();
  });

  it("names the contract, the count, and the remedy", () => {
    const message = findImpureRequests(summaryOf(scenario({ impureRequestCount: 9 })));

    expect(message).toContain("9 requests");
    expect(message).toContain("pure function of (state, ordinal)");
    // The remedy, not just the diagnosis: someone reached for `pop()` *because* they wanted a
    // different seat per request, and "your builder is impure" does not tell them what to write.
    expect(message).toContain("seats[ordinal % seats.length]");
  });

  it("is not the broken-observations message wearing a different hat", () => {
    // Its own finder because routing it through `brokenObservations` told a config with neither a
    // check nor an `onResponse` that "a check or onResponse threw" — D2-04's own failure mode, a
    // report accusing the reader of something they did not do.
    const summary = summaryOf(scenario({ impureRequestCount: 9 }));

    expect(findBrokenObservations(summary)).toBeUndefined();
    expect(findImpureRequests(summary)).toContain("request()");
  });
});

describe("findLostSchedule", () => {
  it("says nothing when a builder failed a few times out of many", () => {
    // Deliberate and documented: a `request()` that throws is counted and the run continues. That
    // is right at three ordinals in ten thousand, and a finder that failed the run on any build
    // error would be a different tool.
    expect(
      findLostSchedule(
        summaryOf(
          scenario({ scheduledCount: 10_000, dispatchedCount: 9997, requestErrorCount: 3 }),
        ),
      ),
    ).toBeUndefined();
  });

  it("fails the run when more requests were never built than were sent", () => {
    // The p99 below it would be computed from one sample of ten and printed beside a green
    // threshold — the tool congratulating a target it barely touched.
    const message = findLostSchedule(
      summaryOf(scenario({ scheduledCount: 10, dispatchedCount: 1, requestErrorCount: 9 })),
    );

    expect(message).toContain("never built 9 of its 10 requests");
    expect(message).toContain("describe a minority of the run");
  });

  it("counts both kinds of unbuilt against the dispatches, not each alone", () => {
    // Five and five each lose to four dispatches separately, and together they are the story.
    expect(
      findLostSchedule(
        summaryOf(
          scenario({
            scheduledCount: 14,
            dispatchedCount: 4,
            requestErrorCount: 5,
            impureRequestCount: 5,
          }),
        ),
      ),
    ).toContain("never built 10");
  });

  it("carries the advice, so the message names a knob and not just a number", () => {
    expect(
      findLostSchedule(
        summaryOf(scenario({ scheduledCount: 10, dispatchedCount: 1, impureRequestCount: 9 })),
      ),
    ).toContain("seats[ordinal % seats.length]");
  });
});

describe("findBrokenObservations", () => {
  it("says nothing when every claim held together", () => {
    expect(findBrokenObservations(summaryOf(scenario()))).toBeUndefined();
  });

  it("fails the run when a check threw, naming the scenario", () => {
    // D2-04: the measurements are real, but at least one claim about them is not — and that is a
    // different sentence from "the target violated an invariant".
    const message = findBrokenObservations(summaryOf(scenario({ brokenObservations: 7 })));

    expect(message).toContain('"reads"');
    expect(message).toContain("7 broken observations");
    expect(message).toContain("at least one of its claims is not");
  });
});

describe("evaluateThresholds", () => {
  const summary = summaryOf(scenario());

  it("reports nothing violated when every claim holds", () => {
    const verdict = evaluateThresholds(
      [
        { name: "answered everything", assert: (s) => s.scenarios[0]?.responseCount === 10 },
        { name: "nothing dropped", assert: (s) => s.droppedCount === 0 },
      ],
      summary,
    );

    expect(verdict.violated).toEqual([]);
    expect(verdict.broken).toEqual([]);
    expect(verdict.results.every((r) => r.held)).toBe(true);
  });

  it("lets a threshold read a scenario's own counters and checks", () => {
    // D2-03, and the shape open-ticket's contract run 1 is written in.
    const verdict = evaluateThresholds(
      [
        {
          name: "exactly one buyer wins",
          assert: (s) => s.scenarios[0]?.counters.reserved201 === 1,
        },
        {
          name: "no double sells",
          assert: (s) => s.scenarios[0]?.checks.noDoubleSell?.failed === 0,
        },
      ],
      summaryOf(
        scenario({
          counters: { reserved201: 1 },
          checks: { noDoubleSell: { passed: 500, failed: 0, broken: 0 } },
        }),
      ),
    );

    expect(verdict.violated).toEqual([]);
  });

  it("names the claim that broke, not the expression", () => {
    // D1-06's whole reason for a named predicate over a string mini-language.
    const verdict = evaluateThresholds(
      [{ name: "exactly one buyer wins", assert: () => false }],
      summary,
    );

    expect(verdict.violated).toEqual(["exactly one buyer wins"]);
  });

  it("keeps a predicate that threw apart from one that returned false", () => {
    // A typo reaching into a scenario that does not exist is the config's mistake. Counting it as a
    // violation would blame the target for it, so it lands on the run-failed code instead.
    const verdict = evaluateThresholds(
      [
        { name: "broken claim", assert: (s) => (s as never as { x: { y: number } }).x.y === 1 },
        { name: "honest failure", assert: () => false },
      ],
      summary,
    );

    expect(verdict.broken).toEqual(["broken claim"]);
    expect(verdict.violated).toEqual(["honest failure"]);
    expect(verdict.results[0]?.error).toBeTruthy();
    // Not merely "not violated": a broken predicate must never read as held, or the natural
    // `results.every(r => r.held)` summary line would report it as a pass.
    expect(verdict.results[0]?.held).toBe(false);
  });

  it("treats a predicate that returned a non-boolean as broken, not violated", () => {
    // Node strips the user's types without checking them, so `assert: (s) => { s.x === 1 }` —
    // braces instead of an expression body — returns undefined. Calling that a violation would
    // exit 1 and blame the target for a config typo.
    const verdict = evaluateThresholds(
      [{ name: "braces not parens", assert: (() => undefined) as unknown as () => boolean }],
      summary,
    );

    expect(verdict.broken).toEqual(["braces not parens"]);
    expect(verdict.violated).toEqual([]);
    expect(verdict.results[0]?.error).toContain("undefined");
  });

  it("has nothing to say when no thresholds were declared", () => {
    const verdict = evaluateThresholds([], summary);

    expect(verdict.results).toEqual([]);
    expect(verdict.violated).toEqual([]);
  });
});

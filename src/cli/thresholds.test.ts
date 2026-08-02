import { describe, expect, it } from "vitest";
import type { RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import {
  evaluateThresholds,
  findBrokenObservations,
  findRefusedRecordings,
  findUnmeasuredScenario,
} from "./thresholds.ts";

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
  latencyMs: undefined,
  scheduledLatencyMs: undefined,
  scheduleLagMs: undefined,
  counters: {},
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

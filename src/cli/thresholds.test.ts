import { describe, expect, it } from "vitest";
import type { RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import { evaluateThresholds } from "./thresholds.ts";

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

import { describe, expect, it } from "vitest";
import { verdict } from "./harness.ts";

/**
 * The gate's whole contract as a table: how many claims ran, how many failed, and what the nightly
 * workflow is told. It classifies on the *line* as well as the code, so both are pinned here.
 */

describe("verdict", () => {
  it("passes, naming the count so the banner cannot drift from the docs", () => {
    expect(verdict(0, 39)).toEqual({
      line: "GATE TWO PASSED — 39 claims, the numbers are true against a target that knows better",
      exitCode: 0,
    });
  });

  it("fails on exit 1, with the line the workflow greps for", () => {
    // `^GATE TWO FAILED` is what `.github/workflows/gate-two.yml` matches. Rewording this line
    // without touching the workflow would silently stop the nightly opening issues.
    const outcome = verdict(4, 39);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toMatch(/^GATE TWO FAILED/);
    expect(outcome.line).toContain("4 claim(s)");
  });

  it("refuses to call an empty gate a pass", () => {
    // Zero claims is exit 2, not 0. A refactor that stopped calling `claim()` would otherwise turn
    // the nightly into a green light over a run that measured nothing — the same lie as a
    // percentile drawn from an empty histogram.
    expect(verdict(0, 0)).toEqual({
      line: "GATE TWO COULD NOT RUN — no claims were made",
      exitCode: 2,
    });
  });

  it("never reports a failure without the line, or the line without the code", () => {
    // The two must not disagree: a grep hit on a non-1 exit, or a 1 without the line, is how the
    // nightly opens an issue about the wrong thing or stays silent about the right one.
    for (const [failures, total] of [
      [0, 39],
      [1, 39],
      [39, 39],
      [0, 0],
      [0, 1],
    ] as const) {
      const outcome = verdict(failures, total);

      expect(outcome.line.startsWith("GATE TWO FAILED")).toBe(outcome.exitCode === 1);
    }
  });
});

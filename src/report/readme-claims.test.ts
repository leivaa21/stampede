import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_COUNTERS } from "../engine/metric-names.ts";
import {
  MAX_DISTINCT_TALLIES,
  MAX_KEYS_PER_COUNTER,
  MIN_FREE_TALLIES_PER_SCENARIO,
} from "../metrics/validate.ts";

/**
 * The README's derived numbers, pinned to the constants they were derived from.
 *
 * Prose rots silently and this repo has watched it happen three times in one milestone: a published
 * throughput figure from a build two milestones old, a docblock quoting a slot count that a later
 * slice invalidated by adding two engine counters, and a limits paragraph out by 136 slots. Every
 * one was found by a human reading carefully, which does not scale and did not catch them early.
 *
 * So the numbers a reader would plan a config against are asserted here. Add an engine counter and
 * CI goes red with the line to fix, rather than the showcase README quietly starting to lie.
 *
 * Deliberately narrow: only figures *derived from constants*. Prose that merely describes behaviour
 * belongs to the reviewer and to the tests, not to a string match.
 *
 * Figures that change every commit — the test count above all — are not pinned here but written as
 * a floor ("550+ tests"), because a number re-typed by hand on every slice is wrong on most of
 * them. That was learned the direct way: this file was added to stop prose rot, and the very next
 * hand-written count in `CLAUDE.md` was already stale.
 */

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

describe("the README's arithmetic matches the code", () => {
  it("states the counter budget a scenario really has", () => {
    expect(README).toContain(`${String(MAX_DISTINCT_TALLIES)}-name budget`);
  });

  it("states how many slots stay free for plain counters", () => {
    expect(README).toContain(`**${String(MIN_FREE_TALLIES_PER_SCENARIO)} stay free**`);
  });

  it("states how many counters stampede reserves for itself", () => {
    expect(README).toContain(`stampede's own ${String(ENGINE_COUNTERS.length)}`);
  });

  it("states what a declaration is actually allowed, derived rather than guessed", () => {
    const declarable =
      MAX_DISTINCT_TALLIES - MIN_FREE_TALLIES_PER_SCENARIO - ENGINE_COUNTERS.length;

    expect(README).toContain(`**${String(declarable)} slots, minus one per check**`);
  });

  it("states the per-counter key limit", () => {
    expect(README).toContain(`${String(MAX_KEYS_PER_COUNTER)} keys per counter`);
  });
});

import { describe, expect, it } from "vitest";
import { Checks } from "./checks.ts";
import { MAX_DISTINCT_TALLIES } from "./validate.ts";

const checksOf = (outcomes: Readonly<Record<string, readonly boolean[]>>): Checks => {
  const checks = new Checks();
  for (const [name, results] of Object.entries(outcomes)) {
    for (const passed of results) {
      checks.record(name, passed);
    }
  }
  return checks;
};

describe("Checks", () => {
  it("tallies both sides of every named check", () => {
    const checks = checksOf({ "no double sell": [true, true, false] });

    expect(checks.get("no double sell")).toEqual({ passed: 2, failed: 1 });
  });

  it("distinguishes a check that passed from a check that never ran", () => {
    const checks = checksOf({ ran: [true] });

    expect(checks.get("ran")).toEqual({ passed: 1, failed: 0 });
    expect(checks.get("never ran")).toEqual({ passed: 0, failed: 0 });
    expect(checks.names).toEqual(["ran"]);
  });

  it("lists its names in a reproducible order", () => {
    expect(checksOf({ zulu: [true], alpha: [true] }).names).toEqual(["alpha", "zulu"]);
  });

  /**
   * `readonly` is compile-time only and `Checks` ships in `dist` for plain JS. The tally returned
   * for an unknown name used to be a shared module singleton that `record` and `merge` also built
   * on, so one consumer writing to it poisoned every `Checks` in the process.
   */
  it("hands out tallies nothing else can write through", () => {
    const poisoner = new Checks();
    const tally = poisoner.get("ghost");

    expect(Object.isFrozen(tally)).toBe(true);
    expect(() => {
      Object.assign(tally, { passed: 999 });
    }).toThrow(TypeError);

    const untouched = new Checks();
    untouched.record("brand new check", true);

    expect(untouched.get("brand new check")).toEqual({ passed: 1, failed: 0 });
    expect(new Checks().get("ghost")).toEqual({ passed: 0, failed: 0 });
  });

  it("freezes known tallies too, so a snapshot cannot be edited through one", () => {
    const checks = checksOf({ "no double sell": [true] });
    const tally = checks.get("no double sell");

    expect(Object.isFrozen(tally)).toBe(true);
    expect(() => {
      Object.assign(tally, { failed: 42 });
    }).toThrow(TypeError);
    expect(checks.toSnapshot().tallies.get("no double sell")).toEqual({ passed: 1, failed: 0 });
  });

  it("rejects an empty name", () => {
    expect(() => {
      new Checks().record("", true);
    }).toThrow(RangeError);
  });
});

describe("Checks.merge", () => {
  it("adds shared names and carries disjoint ones", () => {
    const merged = checksOf({ shared: [true, false], onlyLeft: [true] }).merge(
      checksOf({ shared: [false], onlyRight: [false] }),
    );

    expect(merged.get("shared")).toEqual({ passed: 1, failed: 2 });
    expect(merged.get("onlyLeft")).toEqual({ passed: 1, failed: 0 });
    expect(merged.get("onlyRight")).toEqual({ passed: 0, failed: 1 });
  });

  it("leaves both operands untouched", () => {
    const left = checksOf({ shared: [true] });
    const right = checksOf({ shared: [false] });

    left.merge(right);

    expect(left.get("shared")).toEqual({ passed: 1, failed: 0 });
    expect(right.get("shared")).toEqual({ passed: 0, failed: 1 });
  });

  it("is commutative and associative", () => {
    const a = checksOf({ x: [true], y: [false] });
    const b = checksOf({ y: [true, true], z: [false] });
    const c = checksOf({ x: [false], z: [true] });

    expect(a.merge(b).toSnapshot()).toEqual(b.merge(a).toSnapshot());
    expect(a.merge(b).merge(c).toSnapshot()).toEqual(a.merge(b.merge(c)).toSnapshot());
  });

  it("round-trips through a structured clone", () => {
    const checks = checksOf({ "exactly one 201": [true], "no double sell": [true, false] });

    const restored = Checks.fromSnapshot(structuredClone(checks.toSnapshot()));

    expect(restored.toSnapshot()).toEqual(checks.toSnapshot());
  });

  it("carries the refusal count through merge and a round-trip", () => {
    const left = new Checks();
    const right = new Checks();
    for (const checks of [left, right]) {
      for (let index = 0; index <= MAX_DISTINCT_TALLIES; index += 1) {
        checks.record(`c${String(index)}`, true);
      }
    }

    expect(left.refusedCount).toBe(1);
    expect(left.merge(right).refusedCount).toBe(2);
    expect(Checks.fromSnapshot(structuredClone(left.toSnapshot())).refusedCount).toBe(1);
  });
});

describe("Checks cardinality", () => {
  it("refuses unbounded distinct names and counts what it refused", () => {
    const checks = new Checks();
    for (let request = 0; request < MAX_DISTINCT_TALLIES + 7; request += 1) {
      checks.record(`request-${String(request)}`, true);
    }

    expect(checks.names).toHaveLength(MAX_DISTINCT_TALLIES);
    expect(checks.refusedCount).toBe(7);
    expect(checks.get(`request-${String(MAX_DISTINCT_TALLIES + 1)}`)).toEqual({
      passed: 0,
      failed: 0,
    });
  });
});

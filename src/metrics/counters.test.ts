import { describe, expect, it } from "vitest";
import { Counters } from "./counters.ts";
import { MAX_DISTINCT_TALLIES, MAX_METRIC_NAME_LENGTH } from "./validate.ts";

const countersOf = (totals: Readonly<Record<string, number>>): Counters => {
  const counters = new Counters();
  for (const [name, total] of Object.entries(totals)) {
    counters.inc(name, total);
  }
  return counters;
};

describe("Counters", () => {
  it("counts by one unless told otherwise", () => {
    const counters = new Counters();

    counters.inc("reserved201");
    counters.inc("reserved201");
    counters.inc("conflict409", 7);

    expect(counters.get("reserved201")).toBe(2);
    expect(counters.get("conflict409")).toBe(7);
  });

  it("reports zero for a counter that never fired", () => {
    expect(new Counters().get("never")).toBe(0);
    expect(new Counters().names).toEqual([]);
  });

  it("lists its names in a reproducible order", () => {
    expect(countersOf({ zulu: 1, alpha: 1, mike: 1 }).names).toEqual(["alpha", "mike", "zulu"]);
  });

  it("rejects an empty name and a nonsensical increment", () => {
    const counters = new Counters();

    expect(() => {
      counters.inc("");
    }).toThrow(RangeError);
    expect(() => {
      counters.inc("ok", -1);
    }).toThrow(RangeError);
    expect(() => {
      counters.inc("ok", 1.5);
    }).toThrow(RangeError);
    expect(() => {
      counters.inc("ok", Number.NaN);
    }).toThrow(RangeError);
  });
});

describe("Counters.merge", () => {
  it("adds shared names and carries disjoint ones", () => {
    const merged = countersOf({ shared: 2, onlyLeft: 1 }).merge(
      countersOf({ shared: 3, onlyRight: 5 }),
    );

    expect(merged.get("shared")).toBe(5);
    expect(merged.get("onlyLeft")).toBe(1);
    expect(merged.get("onlyRight")).toBe(5);
  });

  it("leaves both operands untouched", () => {
    const left = countersOf({ shared: 2 });
    const right = countersOf({ shared: 3 });

    left.merge(right);

    expect(left.get("shared")).toBe(2);
    expect(right.get("shared")).toBe(3);
  });

  it("is commutative and associative", () => {
    const a = countersOf({ x: 1, y: 2 });
    const b = countersOf({ y: 3, z: 4 });
    const c = countersOf({ x: 5, z: 6 });

    expect(a.merge(b).toSnapshot()).toEqual(b.merge(a).toSnapshot());
    expect(a.merge(b).merge(c).toSnapshot()).toEqual(a.merge(b.merge(c)).toSnapshot());
  });

  it("round-trips through a structured clone", () => {
    const counters = countersOf({ reserved201: 1, conflict409: 499 });

    const restored = Counters.fromSnapshot(structuredClone(counters.toSnapshot()));

    expect(restored.toSnapshot()).toEqual(counters.toSnapshot());
  });

  it("carries the refusal count through merge and a round-trip", () => {
    const left = new Counters();
    const right = new Counters();
    for (const counters of [left, right]) {
      for (let index = 0; index <= MAX_DISTINCT_TALLIES; index += 1) {
        counters.inc(`c${String(index)}`);
      }
    }

    expect(left.refusedCount).toBe(1);
    expect(left.merge(right).refusedCount).toBe(2);
    expect(Counters.fromSnapshot(structuredClone(left.toSnapshot())).refusedCount).toBe(1);
  });
});

describe("Counters cardinality", () => {
  // The natural mistake the cap exists for: a counter named after a per-request header value.
  it("refuses unbounded distinct names and counts what it refused", () => {
    const counters = new Counters();
    for (let request = 0; request < MAX_DISTINCT_TALLIES + 25; request += 1) {
      counters.inc(`request-${String(request)}`);
    }

    expect(counters.names).toHaveLength(MAX_DISTINCT_TALLIES);
    expect(counters.refusedCount).toBe(25);
  });

  it("keeps counting the names admitted before the cap", () => {
    const counters = new Counters();
    for (let request = 0; request < MAX_DISTINCT_TALLIES + 5; request += 1) {
      counters.inc(`request-${String(request)}`);
    }

    counters.inc("request-0", 10);

    expect(counters.get("request-0")).toBe(11);
    expect(counters.get(`request-${String(MAX_DISTINCT_TALLIES + 1)}`)).toBe(0);
  });

  it("refuses an absurdly long name even when there is room", () => {
    const counters = new Counters();

    counters.inc("x".repeat(MAX_METRIC_NAME_LENGTH + 1));

    expect(counters.names).toEqual([]);
    expect(counters.refusedCount).toBe(1);
  });

  it("does not throw, because a run must survive a reporting mistake", () => {
    const counters = new Counters();

    expect(() => {
      counters.inc("x".repeat(MAX_METRIC_NAME_LENGTH + 1));
    }).not.toThrow();
  });
});

describe("reserve", () => {
  it("claims a name so a later increment cannot be refused for cardinality", () => {
    const counters = new Counters();
    counters.reserve("stampede.dropped");
    for (let i = 0; i < MAX_DISTINCT_TALLIES + 100; i += 1) {
      counters.inc(`seat-${String(i)}`);
    }

    counters.inc("stampede.dropped", 350);

    // Without the reservation this reads 0, and a run that dropped 350 requests reports a clean
    // sweep — the engine's own bookkeeping starved out by names built from response data.
    expect(counters.get("stampede.dropped")).toBe(350);
  });

  it("never resets a counter that already has a total", () => {
    const counters = new Counters();
    counters.inc("reserved201", 500);

    counters.reserve("reserved201");

    // Today only `runDispatch` reserves, and it does so on an empty map. The moment anything
    // reserves lazily, dropping this guard is a published number silently reset to zero.
    expect(counters.get("reserved201")).toBe(500);
  });

  it("counts a reservation it could not make, rather than dropping it", () => {
    const counters = new Counters();
    for (let i = 0; i < MAX_DISTINCT_TALLIES; i += 1) {
      counters.inc(`seat-${String(i)}`);
    }

    counters.reserve("stampede.dropped");

    // A refusal nobody counts is a silent hole in the numbers (`validate.ts`). Even the engine's
    // own reservation can lose the race if a merged snapshot filled the map first.
    expect(counters.refusedCount).toBe(1);
  });

  it("refuses an empty name like every other recording surface", () => {
    expect(() => {
      new Counters().reserve("");
    }).toThrow(RangeError);
  });

  it("occupies a slot, because the cap describes the size of the map", () => {
    const counters = new Counters();
    counters.reserve("stampede.dropped");
    for (let i = 0; i < MAX_DISTINCT_TALLIES; i += 1) {
      counters.inc(`seat-${String(i)}`);
    }

    expect(counters.names).toHaveLength(MAX_DISTINCT_TALLIES);
    expect(counters.refusedCount).toBe(1);
  });
});

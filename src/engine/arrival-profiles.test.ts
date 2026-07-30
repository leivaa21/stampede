import { describe, expect, it } from "vitest";
import { burst, constantRate, ramp, stages, type ArrivalProfile } from "./arrival-profiles.ts";

const instantsOf = (profile: ArrivalProfile): number[] => [...profile.instants()];

const take = (profile: ArrivalProfile, howMany: number): number[] => {
  const taken: number[] = [];
  for (const instantMs of profile.instants()) {
    taken.push(instantMs);
    if (taken.length === howMany) {
      break;
    }
  }
  return taken;
};

const gapsOf = (instants: readonly number[]): number[] =>
  instants.slice(1).map((instantMs, index) => instantMs - (instants[index] ?? 0));

const isStrictlyIncreasing = (values: readonly number[]): boolean =>
  gapsOf(values).every((gap) => gap > 0);

describe("constantRate", () => {
  it("spaces its dispatches evenly across the stage", () => {
    const profile = constantRate({ ratePerSecond: 10, durationMs: 1_000 });

    expect(profile.count).toBe(10);
    expect(profile.durationMs).toBe(1_000);
    expect(instantsOf(profile)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it("schedules the whole part of the integral and no fractional trailing request", () => {
    // 10 rps for 950 ms integrates to 9.5 requests; the tenth would land past the stage's end.
    const profile = constantRate({ ratePerSecond: 10, durationMs: 950 });

    expect(profile.count).toBe(9);
    expect(instantsOf(profile).at(-1)).toBe(800);
  });

  it("keeps every instant inside its own stage", () => {
    const profile = constantRate({ ratePerSecond: 3, durationMs: 1_000 });
    const instants = instantsOf(profile);

    expect(instants).toHaveLength(3);
    expect(instants.every((instantMs) => instantMs >= 0 && instantMs < profile.durationMs)).toBe(
      true,
    );
    expect(instants[2]).toBeCloseTo(666.67, 2);
  });

  it("derives each instant from its index, so a long run cannot drift", () => {
    // Guards the schedule against a refactor to a running sum: at 700 dispatches an accumulated
    // interval of 1000/7 ms would already have drifted away from the instant it is measured against.
    const instants = instantsOf(constantRate({ ratePerSecond: 7, durationMs: 100_000 }));

    expect(instants).toHaveLength(700);
    expect(instants[699]).toBe((699 * 1_000) / 7);
  });

  it("counts an integral that a double lands a fraction below", () => {
    // 2.9 × 100 is 289.99999999999994 in binary floating point. The 290th request was asked for.
    expect(constantRate({ ratePerSecond: 2.9, durationMs: 100_000 }).count).toBe(290);
  });

  it("schedules nothing at a rate of zero, which makes it an idle gap between stages", () => {
    const profile = constantRate({ ratePerSecond: 0, durationMs: 5_000 });

    expect(profile.count).toBe(0);
    expect(instantsOf(profile)).toEqual([]);
    expect(profile.durationMs).toBe(5_000);
  });

  it("rejects a rate or a duration that is not a duration", () => {
    expect(() => constantRate({ ratePerSecond: -1, durationMs: 1_000 })).toThrow(RangeError);
    expect(() => constantRate({ ratePerSecond: Number.NaN, durationMs: 1_000 })).toThrow(
      RangeError,
    );
    expect(() => constantRate({ ratePerSecond: 10, durationMs: -1 })).toThrow(RangeError);
    expect(() => constantRate({ ratePerSecond: 10, durationMs: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });

  it("generates lazily, so an hour of load costs nothing until it is consumed", () => {
    // Ten thousand rps for an hour is 36 million instants — ~288 MB and about a second if this
    // materialised an array. The bound is loose on purpose: it is a laziness assertion, not a
    // benchmark.
    const profile = constantRate({ ratePerSecond: 10_000, durationMs: 3_600_000 });
    const startedAt = performance.now();

    expect(profile.count).toBe(36_000_000);
    expect(take(profile, 5)).toEqual([0, 1, 2, 3, 4].map((index) => index * 0.1));
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("hands out a fresh sequence on every call", () => {
    const profile = constantRate({ ratePerSecond: 10, durationMs: 1_000 });

    expect(instantsOf(profile)).toEqual(instantsOf(profile));
  });
});

describe("burst", () => {
  it("schedules every request at t = 0", () => {
    const profile = burst({ count: 500 });

    expect(profile.count).toBe(500);
    expect(profile.durationMs).toBe(0);

    const instants = instantsOf(profile);
    expect(instants).toHaveLength(500);
    expect(instants.every((instantMs) => instantMs === 0)).toBe(true);
  });

  it("rejects a count that is not a count", () => {
    expect(() => burst({ count: 1.5 })).toThrow(RangeError);
    expect(() => burst({ count: -1 })).toThrow(RangeError);
  });
});

describe("ramp", () => {
  it("schedules the integral of the rate, not the rate at either end", () => {
    // The trapezoid: (0 + 10)/2 × 2 s = 10 requests.
    const profile = ramp({ fromRatePerSecond: 0, toRatePerSecond: 10, durationMs: 2_000 });

    expect(profile.count).toBe(10);
    expect(instantsOf(profile)).toHaveLength(10);
  });

  it("accelerates: from a standstill the k-th arrival lands at sqrt(k / a)", () => {
    // r(t) = 10t, so N(t) = 5t² and the k-th arrival is at sqrt(k/5) seconds.
    const instants = instantsOf(
      ramp({ fromRatePerSecond: 0, toRatePerSecond: 10, durationMs: 1_000 }),
    );

    expect(instants).toHaveLength(5);
    for (const [index, instantMs] of instants.entries()) {
      expect(instantMs).toBeCloseTo(Math.sqrt(index / 5) * 1_000, 6);
    }
  });

  it("puts a quarter of a ramp-from-zero's arrivals in its first half", () => {
    // Half the time at half the rate is a quarter of the area — the property a per-second
    // staircase approximation would only get right on average.
    const profile = ramp({ fromRatePerSecond: 0, toRatePerSecond: 100, durationMs: 1_000 });
    const instants = instantsOf(profile);

    expect(profile.count).toBe(50);
    // 12.5 by area, plus the arrival that opens the stage at t = 0.
    expect(instants.filter((instantMs) => instantMs < 500)).toHaveLength(13);
  });

  it("decelerates on the way down, and still schedules the area under the line", () => {
    const profile = ramp({ fromRatePerSecond: 10, toRatePerSecond: 0, durationMs: 1_000 });
    const instants = instantsOf(profile);

    expect(profile.count).toBe(5);
    expect(isStrictlyIncreasing(instants)).toBe(true);
    expect(isStrictlyIncreasing(gapsOf(instants))).toBe(true);
    expect(instants.every((instantMs) => instantMs < 1_000)).toBe(true);
  });

  it("is a constant rate when both ends are equal", () => {
    const held = instantsOf(
      ramp({ fromRatePerSecond: 10, toRatePerSecond: 10, durationMs: 1_000 }),
    );
    const constant = instantsOf(constantRate({ ratePerSecond: 10, durationMs: 1_000 }));

    expect(held).toHaveLength(constant.length);
    for (const [index, instantMs] of held.entries()) {
      expect(instantMs).toBeCloseTo(constant[index] ?? Number.NaN, 9);
    }
  });

  it("schedules nothing over no time at all", () => {
    const profile = ramp({ fromRatePerSecond: 10, toRatePerSecond: 100, durationMs: 0 });

    expect(profile.count).toBe(0);
    expect(instantsOf(profile)).toEqual([]);
  });

  it("rejects a negative rate at either end", () => {
    expect(() => ramp({ fromRatePerSecond: -1, toRatePerSecond: 10, durationMs: 1_000 })).toThrow(
      RangeError,
    );
    expect(() => ramp({ fromRatePerSecond: 10, toRatePerSecond: -1, durationMs: 1_000 })).toThrow(
      RangeError,
    );
  });
});

describe("stages", () => {
  it("joins two identical stages into one continuous sequence", () => {
    const composed = stages(
      constantRate({ ratePerSecond: 10, durationMs: 1_000 }),
      constantRate({ ratePerSecond: 10, durationMs: 1_000 }),
    );

    expect(composed.count).toBe(20);
    expect(composed.durationMs).toBe(2_000);
    expect(instantsOf(composed)).toEqual(
      instantsOf(constantRate({ ratePerSecond: 10, durationMs: 2_000 })),
    );
  });

  it("ramps then holds with no gap and no overlap at the seam", () => {
    const rampStage = ramp({ fromRatePerSecond: 0, toRatePerSecond: 10, durationMs: 1_000 });
    const holdStage = constantRate({ ratePerSecond: 10, durationMs: 1_000 });
    const composed = stages(rampStage, holdStage);
    const instants = instantsOf(composed);

    expect(composed.count).toBe(rampStage.count + holdStage.count);
    expect(isStrictlyIncreasing(instants)).toBe(true);

    // The step across the join sits between the steps on either side of it: the ramp is still
    // accelerating into the hold, so the seam is neither a pause nor a double-dispatch.
    const gaps = gapsOf(instants);
    const seam = gaps[rampStage.count - 1] ?? Number.NaN;
    expect(seam).toBeLessThan(gaps[rampStage.count - 2] ?? Number.NaN);
    expect(seam).toBeGreaterThan(gaps[rampStage.count] ?? Number.NaN);
  });

  it("starts the stage after a burst at the same instant, because a burst takes no time", () => {
    const composed = stages(
      burst({ count: 3 }),
      constantRate({ ratePerSecond: 10, durationMs: 500 }),
    );

    expect(composed.count).toBe(8);
    expect(composed.durationMs).toBe(500);
    expect(instantsOf(composed)).toEqual([0, 0, 0, 0, 100, 200, 300, 400]);
  });

  it("counts without generating, and generates one stage at a time", () => {
    let generated = 0;
    const counting: ArrivalProfile = {
      durationMs: 1_000,
      count: 1_000_000,
      *instants(): Generator<number> {
        for (let index = 0; index < 1_000_000; index += 1) {
          generated += 1;
          yield index / 1_000;
        }
      },
    };

    const composed = stages(counting, constantRate({ ratePerSecond: 10, durationMs: 1_000 }));

    expect(composed.count).toBe(1_000_010);
    expect(generated).toBe(0);

    expect(take(composed, 3)).toEqual([0, 0.001, 0.002]);
    expect(generated).toBe(3);
  });

  it("composes to nothing when there is nothing to compose", () => {
    const empty = stages();

    expect(empty.count).toBe(0);
    expect(empty.durationMs).toBe(0);
    expect(instantsOf(empty)).toEqual([]);
  });
});

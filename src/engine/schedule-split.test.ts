import { describe, expect, it } from "vitest";
import { burst, constantRate, ramp, stages } from "./arrival-profiles.ts";
import { shardMaxInFlight, shardProfile, shardScenarios } from "./schedule-split.ts";
import { mergedSchedule } from "./schedule.ts";

/**
 * The property every number this PR publishes rests on: the shards put back together are the run.
 *
 * If that fails, a multi-worker run is measuring a different load than the one the user asked for,
 * and every percentile drawn from it describes something that never happened. So it is tested as a
 * property across profile shapes and worker counts rather than on one hand-picked example.
 */

const collect = (profile: { instants: () => Iterable<number> }): number[] => [
  ...profile.instants(),
];

const PROFILES = [
  { name: "burst", make: () => burst({ count: 20 }) },
  { name: "constantRate", make: () => constantRate({ ratePerSecond: 25, durationMs: 1_000 }) },
  {
    name: "ramp",
    make: () => ramp({ fromRatePerSecond: 5, toRatePerSecond: 50, durationMs: 2_000 }),
  },
  {
    name: "stages",
    make: () =>
      stages(
        ramp({ fromRatePerSecond: 1, toRatePerSecond: 30, durationMs: 1_000 }),
        constantRate({ ratePerSecond: 30, durationMs: 1_000 }),
      ),
  },
  // A sequence shorter than the worker count: some shards get nothing at all.
  { name: "tiny burst", make: () => burst({ count: 3 }) },
];

describe("shardProfile", () => {
  for (const { name, make } of PROFILES) {
    for (const shardCount of [1, 2, 3, 8]) {
      it(`${name} across ${String(shardCount)} shards reproduces the whole profile`, () => {
        const whole = collect(make());
        const shards = Array.from({ length: shardCount }, (_, index) =>
          collect(shardProfile(make(), { index, count: shardCount })),
        );

        // Union, sorted, is exactly the original — nothing lost, nothing duplicated.
        expect([...shards.flat()].sort((a, b) => a - b)).toEqual(whole);
        // And each shard's reported count matches what it actually generates, so a shard can still
        // describe its own size without generating anything.
        for (const [index, instants] of shards.entries()) {
          expect(shardProfile(make(), { index, count: shardCount }).count).toBe(instants.length);
        }
      });
    }
  }

  it("gives every shard the same wall-clock window as the whole run", () => {
    const whole = constantRate({ ratePerSecond: 10, durationMs: 5_000 });
    const shard = shardProfile(whole, { index: 1, count: 4 });

    // A shard sends fewer requests over the same span, not the same requests over a shorter one.
    expect(shard.durationMs).toBe(whole.durationMs);
  });

  it("is deterministic — the same shard yields the same instants every time", () => {
    const make = (): number[] =>
      collect(
        shardProfile(ramp({ fromRatePerSecond: 3, toRatePerSecond: 40, durationMs: 900 }), {
          index: 2,
          count: 5,
        }),
      );

    expect(make()).toEqual(make());
  });

  it("rejects a shard index outside its own shard count", () => {
    const profile = burst({ count: 4 });

    expect(() => shardProfile(profile, { index: 3, count: 3 })).toThrow(/shard index/);
    expect(() => shardProfile(profile, { index: -1, count: 3 })).toThrow(/shard index/);
  });
});

describe("shardScenarios", () => {
  it("keeps every scenario, its name and its order on each shard", () => {
    const scenarios = [
      { name: "reads", profile: constantRate({ ratePerSecond: 20, durationMs: 1_000 }) },
      { name: "writes", profile: burst({ count: 9 }) },
    ];

    const shard = shardScenarios(scenarios, { index: 0, count: 3 });

    expect(shard.map((s) => s.name)).toEqual(["reads", "writes"]);
  });

  it("reproduces the single-threaded dispatch stream when the shards are merged", () => {
    const scenarios = () => [
      { name: "reads", profile: constantRate({ ratePerSecond: 30, durationMs: 1_000 }) },
      {
        name: "writes",
        profile: ramp({ fromRatePerSecond: 2, toRatePerSecond: 20, durationMs: 1_000 }),
      },
    ];
    const key = (d: { scenario: { name: string }; instantMs: number }): string =>
      `${d.scenario.name}@${d.instantMs.toFixed(6)}`;

    const whole = [...mergedSchedule(scenarios())].map(key).sort();
    const sharded = Array.from({ length: 4 }, (_, index) =>
      [...mergedSchedule(shardScenarios(scenarios(), { index, count: 4 }))].map(key),
    )
      .flat()
      .sort();

    // Per scenario and per instant, four workers dispatch exactly what one would have.
    expect(sharded).toEqual(whole);
  });
});

describe("shardMaxInFlight", () => {
  it("divides the run's budget with the remainder going to the lowest shards", () => {
    const budgets = Array.from({ length: 4 }, (_, index) =>
      shardMaxInFlight(10, { index, count: 4 }),
    );

    expect(budgets).toEqual([3, 3, 2, 2]);
    // The whole budget is handed out — a shard's slack is unusable by its siblings, but no slot
    // is lost entirely.
    expect(budgets.reduce((sum, n) => sum + n, 0)).toBe(10);
  });

  it("hands the whole budget to a single shard", () => {
    expect(shardMaxInFlight(7, { index: 0, count: 1 })).toBe(7);
  });

  it("refuses a budget too small to give every worker a slot", () => {
    // Silently giving a worker zero slots would make it drop 100% of its share while the run
    // reported a healthy cap — a drop count with no visible cause.
    expect(() => shardMaxInFlight(3, { index: 0, count: 8 })).toThrow(/at least the worker count/);
  });
});

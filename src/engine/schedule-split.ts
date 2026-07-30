import type { ArrivalProfile } from "./arrival-profiles.ts";
import type { ScheduledScenario } from "./schedule.ts";
import { assertPositiveCount } from "./validate.ts";

/**
 * Dividing one run's schedule across worker threads, so that the shards put together are the run.
 *
 * The design doc (D1-03) suggested giving each worker `rate / workers` with a phase offset. That
 * works for `constantRate` and gets awkward everywhere else: a `ramp`'s instants come from
 * inverting an integral, and `stages` composes profiles whose boundaries do not divide evenly.
 * Each of those would need its own splitting rule, and each rule would be a fresh chance to lose or
 * duplicate a request.
 *
 * **Stride assignment** avoids all of it: shard `w` of `W` takes the instants at indices
 * `w, w + W, w + 2W, …`. Every profile is a sequence, so this needs to know nothing about how the
 * sequence was produced — and the union of the shards is *exactly* the original, by construction
 * rather than by arithmetic that happens to add up. There is no rounding to get wrong, and a
 * profile shape added later inherits it for free.
 *
 * The cost is that each shard walks the whole sequence and keeps one instant in `W`. Generating an
 * instant is a couple of multiplications with no allocation, so a six-million-dispatch run costs
 * each worker a few million flops of skipping — microseconds of arithmetic against a run measured
 * in minutes. Correctness by construction is worth that trade many times over.
 *
 * Pure, like everything it builds on: no clock, no threads, no I/O.
 */

export interface Shard {
  /** 0-based index of this shard. */
  readonly index: number;
  /** How many shards the run was divided into. */
  readonly count: number;
}

export const assertShard = (shard: Shard): void => {
  assertPositiveCount(shard.count, "shard count");
  if (!Number.isSafeInteger(shard.index) || shard.index < 0 || shard.index >= shard.count) {
    throw new RangeError(
      `shard index must be in [0, ${String(shard.count)}), got ${String(shard.index)}`,
    );
  }
};

/** How many of `total` indices fall on this shard's stride. */
const shardedCount = (total: number, shard: Shard): number =>
  shard.index >= total ? 0 : Math.ceil((total - shard.index) / shard.count);

/**
 * One shard's view of a profile.
 *
 * `durationMs` is unchanged: a shard covers the same wall-clock window as the whole run, just
 * fewer requests inside it. Only `count` shrinks, and it is computed rather than counted, so a
 * shard still reports its size without generating anything — the property `arrival-profiles.ts`
 * relies on for lazy scheduling.
 */
export const shardProfile = (profile: ArrivalProfile, shard: Shard): ArrivalProfile => {
  assertShard(shard);
  return {
    durationMs: profile.durationMs,
    count: shardedCount(profile.count, shard),
    *instants(): Iterable<number> {
      let index = 0;
      for (const instantMs of profile.instants()) {
        if (index % shard.count === shard.index) {
          yield instantMs;
        }
        index += 1;
      }
    },
  };
};

/**
 * Every scenario of a run, restricted to one shard. Names and order are preserved.
 *
 * What is **not** preserved is the global dispatch ordinal: `mergedSchedule` re-derives
 * `ScheduledDispatch.index` from 0 within each shard, so request 0 exists on every worker. Nothing
 * reads it today, but per-request variation is promised for a later PR (`run-spec.ts`), and the
 * natural implementation keys off that index — at which point four workers would each build
 * request 0, 1, 2… and the namesake run (N buyers, N *distinct* seats) would quietly become four
 * buyers per seat. The stride makes the recovery exact when it is needed:
 * `globalIndex = shardIndex + localIndex * shardCount`.
 */
export const shardScenarios = <TScenario extends ScheduledScenario>(
  scenarios: readonly TScenario[],
  shard: Shard,
): TScenario[] =>
  scenarios.map((scenario) => ({ ...scenario, profile: shardProfile(scenario.profile, shard) }));

/**
 * The run's in-flight budget, divided across shards.
 *
 * The cap is a **run-level** resource, and enforcing that exactly across threads would need shared
 * atomics on the dispatch path — which D1-03 rules out, because the cost of a shared mutable
 * counter is paid on every single request while the benefit shows up only at saturation.
 *
 * So the budget is split the way the schedule is: `floor(cap / shards)` each, remainder to the
 * lowest-numbered shards, exactly like the stride assignment. The honest cost, and it belongs in
 * the report rather than in a footnote: **a shard cannot borrow another shard's slack.** A run can
 * drop a request while a sibling worker sat idle with a free slot. That is a real difference from
 * the single-threaded cap, it makes drops appear slightly sooner than a perfectly shared budget
 * would, and it is the price of never touching a lock on the hot path.
 */
export const shardMaxInFlight = (maxInFlight: number, shard: Shard): number => {
  assertShard(shard);
  assertPositiveCount(maxInFlight, "maxInFlight");
  if (maxInFlight < shard.count) {
    throw new RangeError(
      `maxInFlight (${String(maxInFlight)}) must be at least the worker count ` +
        `(${String(shard.count)}), or some workers would start with no in-flight budget and drop ` +
        `every request they were given. Raise maxInFlight or lower the worker count.`,
    );
  }
  return Math.floor(maxInFlight / shard.count) + (shard.index < maxInFlight % shard.count ? 1 : 0);
};

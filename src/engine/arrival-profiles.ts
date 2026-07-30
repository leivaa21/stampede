import { assertCount, assertDurationMs, assertRatePerSecond } from "./validate.ts";

/**
 * Arrival profiles: **when** a run dispatches, decided in advance and independently of whether any
 * response ever comes back.
 *
 * That independence is the whole of D1-01. A closed-loop generator asks "has the last response
 * arrived?" before sending the next request, so a slow target quietly makes it send less, and the
 * latency samples it does collect are drawn disproportionately from the moments the target was
 * healthy — coordinated omission, and a p99 that flatters the system exactly when the truth
 * matters. A profile that never consults a response cannot do that.
 *
 * Pure by rule, like `metrics/`: no clock, no I/O, nothing here knows what time it is. The
 * instants are ms offsets from the start of the profile, and `dispatcher.ts` is the only file that
 * turns them into sends.
 *
 * Instants are generated **lazily**. A 10 000 rps ten-minute run is six million of them; a
 * materialised array of those is 48 MB and a second of startup, for a list that is consumed once
 * in order. `count` and `durationMs` are known up front regardless — they are integrals, not
 * lengths of a list — so nothing has to be generated in order to be reported.
 *
 * Field names carry their unit (`ratePerSecond`, `durationMs`) for the same reason `Trend`'s do: a
 * caller that hands seconds to a millisecond parameter should not get a run that is a thousand
 * times too short. The scenario config in a later PR is free to present shorter names.
 */

const MS_PER_SECOND = 1000;

export interface ArrivalProfile {
  /** Wall-clock span the profile occupies. `0` for a burst — it is instantaneous by definition. */
  readonly durationMs: number;
  /** Dispatches it schedules, known without generating any of them. */
  readonly count: number;
  /**
   * A fresh, lazy, ascending sequence of dispatch instants in ms from the profile's start, every
   * one of them in `[0, durationMs)` — except a burst, which schedules all of its instants at 0.
   *
   * Deterministic: the same profile yields the same instants on every call and on every run, which
   * is what makes a published report reproducible by whoever re-runs it.
   */
  instants(): Iterable<number>;
}

/**
 * Slack allowed when flooring an arrival count, in units of the double's own resolution.
 *
 * Not slack for the user's numbers — slack for the mantissa. 2.9 rps over 100 s multiplies out to
 * 289.99999999999994, and dropping the 290th request over the last bit of a double would make the
 * instant count stop matching the integral a reader computes by hand, for a reason no reader could
 * ever see. Eight ulps is far below one request and far above the error of a couple of
 * multiplications.
 */
const FLOOR_TOLERANCE_ULPS = 8;

/**
 * Arrivals scheduled by a stage whose rate integrates to `total` requests over its duration.
 *
 * Floored: a stage ends when its duration is up, so the fractional trailing request belongs to the
 * next stage or to nobody. Flooring is also what makes composition seamless — see `stages`.
 */
const arrivalsIn = (total: number): number =>
  Math.floor(total + Math.abs(total) * Number.EPSILON * FLOOR_TOLERANCE_ULPS);

export interface ConstantRateOptions {
  /**
   * Requests per second. `0` is legal and schedules nothing: an idle gap **between** two stages.
   *
   * As the *last* stage it does nothing at all — a run ends when its schedule is exhausted, not
   * when the profile's declared span is up, so a trailing idle stage contributes its duration to
   * `requestedRatePerSecond` and no waiting. "Burst, then hold the run open for the stragglers" is
   * a natural reading and the wrong one; `drainTimeoutMs` is how you wait for outstanding
   * responses.
   */
  readonly ratePerSecond: number;
  readonly durationMs: number;
}

/**
 * Evenly spaced arrivals — deliberately **not** Poisson.
 *
 * Real traffic arrives Poisson-distributed, and a load tester that models it is more realistic.
 * But a stampede report is meant to be pasted into a README and re-run by a stranger, and a
 * profile that only reproduces in distribution does not reproduce (D1-01). Reproducibility beats
 * realism for an instrument; Poisson arrivals are named in the design doc's deferred list.
 *
 * Each instant is `index × interval` rather than a running sum, so a long run cannot accumulate
 * floating-point drift in the schedule the whole report is measured against.
 */
export const constantRate = ({
  ratePerSecond,
  durationMs,
}: ConstantRateOptions): ArrivalProfile => {
  assertRatePerSecond(ratePerSecond, "constantRate rate");
  assertDurationMs(durationMs, "constantRate duration");

  const count = arrivalsIn((ratePerSecond * durationMs) / MS_PER_SECOND);
  const intervalMs = MS_PER_SECOND / ratePerSecond;
  return {
    durationMs,
    count,
    *instants(): Generator<number> {
      for (let index = 0; index < count; index += 1) {
        yield index * intervalMs;
      }
    },
  };
};

export interface RampOptions {
  readonly fromRatePerSecond: number;
  readonly toRatePerSecond: number;
  readonly durationMs: number;
}

/**
 * Instant of the `index`-th arrival, in seconds, on a ramp starting at `startRate` with
 * `acceleration` = half the slope — the positive root of `acceleration·t² + startRate·t − index`.
 *
 * Written as `2k / (b + √(b² + 4ak))` rather than the textbook `(−b + √(b² + 4ak)) / 2a`. The two
 * are equal in exact arithmetic; the textbook form subtracts two nearly-equal numbers on a shallow
 * ramp (small `a`, large `b`) and loses precision doing it. For the ramps anyone actually writes
 * that costs a few digits out of 16 — not enough to move a dispatch instant, so no test can tell
 * the two apart. The stable form is used because it is free, not because the naive one is known to
 * break here.
 */
const arrivalInstantSec = (index: number, startRate: number, acceleration: number): number => {
  if (index === 0) {
    // The first arrival opens the stage. Also the only index where the root is 0/0, on a ramp
    // that starts from a standstill.
    return 0;
  }
  const discriminant = Math.max(0, startRate * startRate + 4 * acceleration * index);
  return (2 * index) / (startRate + Math.sqrt(discriminant));
};

/**
 * A linear ramp between two rates — the profile that finds where a system's knee is.
 *
 * The instants come from **inverting the integral of the rate**, not from re-deriving a constant
 * rate once per second. With `r(t) = from + (to − from)·t/D`, arrivals by time `t` are
 * `N(t) = from·t + (to − from)·t²/(2D)`, so the k-th arrival is the `t` where `N(t) = k`: one
 * quadratic per instant. Slicing the ramp into one-second constant-rate steps would be easier to
 * write and wrong in the way that matters here — it turns the arrival times into a staircase, so a
 * ramp meant to locate a knee reports it at whichever step boundary the staircase happened to land
 * on rather than where the system actually broke.
 *
 * The total is the trapezoid `(from + to)/2 × duration`, computed directly rather than by
 * iterating, so `count` costs nothing on a profile nobody has started yet.
 */
export const ramp = ({
  fromRatePerSecond,
  toRatePerSecond,
  durationMs,
}: RampOptions): ArrivalProfile => {
  assertRatePerSecond(fromRatePerSecond, "ramp from");
  assertRatePerSecond(toRatePerSecond, "ramp to");
  assertDurationMs(durationMs, "ramp duration");

  const durationSec = durationMs / MS_PER_SECOND;
  const count = arrivalsIn(((fromRatePerSecond + toRatePerSecond) / 2) * durationSec);
  const acceleration =
    durationSec === 0 ? 0 : (toRatePerSecond - fromRatePerSecond) / (2 * durationSec);

  return {
    durationMs,
    count,
    *instants(): Generator<number> {
      for (let index = 0; index < count; index += 1) {
        yield arrivalInstantSec(index, fromRatePerSecond, acceleration) * MS_PER_SECOND;
      }
    },
  };
};

export interface BurstOptions {
  readonly count: number;
}

/**
 * `count` arrivals at t = 0 — the namesake run: N buyers, one seat, all at once.
 *
 * A burst has zero duration, so a stage following one starts at the same instant. That is the
 * intended reading: `stages(burst({ count: 500 }), hold)` means "500 at once, then the hold", not
 * "500 at once, then a pause of unspecified length".
 */
export const burst = ({ count }: BurstOptions): ArrivalProfile => {
  assertCount(count, "burst count");

  return {
    durationMs: 0,
    count,
    *instants(): Generator<number> {
      for (let index = 0; index < count; index += 1) {
        yield 0;
      }
    },
  };
};

/**
 * Ordered composition — `stages(ramp({…}), constantRate({…}))` is ramp-then-hold, which is what
 * most real runs want and what D1-01 requires a profile to express.
 *
 * Each stage keeps its own instants, offset by the durations of the stages before it, so the seam
 * is continuous by construction rather than by a special case: flooring the arrival count leaves a
 * stage's last instant short of its own duration by roughly one interval, and the next stage's
 * first instant sits exactly on the boundary. No gap, no overlap, nothing to fix up at the join.
 *
 * Lazy one stage at a time — only the stage being consumed has a live generator.
 */
export const stages = (...profiles: readonly ArrivalProfile[]): ArrivalProfile => ({
  durationMs: profiles.reduce((total, profile) => total + profile.durationMs, 0),
  count: profiles.reduce((total, profile) => total + profile.count, 0),
  *instants(): Generator<number> {
    let offsetMs = 0;
    for (const profile of profiles) {
      for (const instantMs of profile.instants()) {
        yield offsetMs + instantMs;
      }
      offsetMs += profile.durationMs;
    }
  },
});

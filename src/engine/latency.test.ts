import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../metrics/index.ts";
import { microsecondsBetween, recordLatencies } from "./latency.ts";
import { EngineMetric } from "./metric-names.ts";

/**
 * The arithmetic D1-01 is named after.
 *
 * This file had no test until a review pass found two mutations of it surviving the whole suite:
 * flooring instead of rounding, and dropping the nanosecond pre-rounding entirely. Both move
 * reported latency *down* — the flattering direction the repo's own decisions log rules out — and
 * both are invisible in an end-to-end dispatcher test, because a sub-microsecond error disappears
 * into a millisecond-scale assertion. So they get pinned here, at the unit.
 */

describe("microsecondsBetween", () => {
  it("does not let binary float noise cost a whole spurious microsecond", () => {
    // `2.007 * 1000` is 2007.0000000000002 in binary floating point, and `Histogram.record` ceils
    // fractions — so without the nanosecond pre-rounding this sample would be charged 2008 µs for
    // a duration that was exactly 2007. Rounding at a scale far below the instrument's own
    // resolution is what keeps that noise out.
    expect(microsecondsBetween(0, 2.007)).toBe(2007);
    expect(microsecondsBetween(0, 1.021)).toBe(1021);
  });

  it("keeps sub-microsecond precision that is really there", () => {
    // Pre-rounding is at nanosecond scale, so genuine fractions of a microsecond survive it. The
    // histogram decides what to do with them; this function does not quietly discard them.
    expect(microsecondsBetween(0, 2.0471)).toBe(2047.1);
    expect(microsecondsBetween(0, 0.0009)).toBe(0.9);
  });

  it("never reports a duration below the truth", () => {
    // Rounds, never floors. Flooring would bias every sample toward the target across a whole run
    // — small per sample, and always in the direction that makes a system look faster than it is.
    for (const durationMs of [0.0004999, 1.9995, 12.34567, 0.5005]) {
      const reported = microsecondsBetween(0, durationMs);
      const exactUs = durationMs * 1000;

      expect(reported).toBeGreaterThanOrEqual(exactUs - 0.5);
      expect(Math.abs(reported - exactUs)).toBeLessThan(1);
    }
  });

  it("clamps a backwards clock to zero instead of aborting the run", () => {
    // The clock port promises monotonicity. A clock that breaks that promise should not be able to
    // end a twenty-minute run with a RangeError out of Histogram.record — a load tester that dies
    // mid-run publishes nothing.
    expect(microsecondsBetween(10, 5)).toBe(0);
    expect(microsecondsBetween(10, 10)).toBe(0);
  });

  it("measures a duration, not two absolute instants", () => {
    expect(microsecondsBetween(1_000_000, 1_000_050)).toBe(microsecondsBetween(0, 50));
  });
});

/**
 * A recorded duration comes back as the top of its histogram bucket: at or above the truth by under
 * 0.1 %. Asserting that bound rather than an exact number keeps the honest direction of the error
 * inside the test — an exact-equality assertion here would be asserting the bucket layout, not the
 * timing.
 */
const expectUs = (recordedUs: number | undefined, expectedUs: number): void => {
  expect(recordedUs).toBeGreaterThanOrEqual(expectedUs);
  expect(recordedUs).toBeLessThanOrEqual(expectedUs * 1.001);
};

describe("recordLatencies", () => {
  it("starts the two stopwatches at different instants — the whole point of D1-01", () => {
    const metrics = new MetricsRegistry().scenario("reads");

    // Scheduled for 100ms, actually sent at 400ms (the generator was 300ms behind), answered at
    // 450ms. The target took 50ms; the user who asked at 100ms waited 350ms.
    recordLatencies(metrics, { scheduledAtMs: 100, sentAtMs: 400, doneAtMs: 450 });

    const latency = metrics.findHistogram(EngineMetric.latency)?.summary();
    const scheduled = metrics.findHistogram(EngineMetric.scheduledLatency)?.summary();

    expectUs(latency?.max, 50_000);
    expectUs(scheduled?.max, 350_000);
    // A tool measuring only from the send would report the 50ms and call it a p99. That gap is
    // exactly the coordinated omission this project exists to refuse.
    expect(scheduled?.max).toBeGreaterThan(latency?.max ?? Infinity);
  });

  it("reports the two as equal when the generator kept up", () => {
    const metrics = new MetricsRegistry().scenario("reads");

    recordLatencies(metrics, { scheduledAtMs: 100, sentAtMs: 100, doneAtMs: 150 });

    expectUs(metrics.findHistogram(EngineMetric.latency)?.summary()?.max, 50_000);
    expectUs(metrics.findHistogram(EngineMetric.scheduledLatency)?.summary()?.max, 50_000);
  });

  it("records one sample in each distribution per response", () => {
    const metrics = new MetricsRegistry().scenario("reads");

    recordLatencies(metrics, { scheduledAtMs: 0, sentAtMs: 0, doneAtMs: 10 });
    recordLatencies(metrics, { scheduledAtMs: 0, sentAtMs: 0, doneAtMs: 20 });

    expect(metrics.findHistogram(EngineMetric.latency)?.count).toBe(2);
    expect(metrics.findHistogram(EngineMetric.scheduledLatency)?.count).toBe(2);
  });
});

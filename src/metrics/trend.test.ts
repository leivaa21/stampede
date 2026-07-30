import { describe, expect, it } from "vitest";
import { MAX_TRACKABLE_MS, Trend } from "./trend.ts";

const trendOf = (samplesMs: Iterable<number>): Trend => {
  const trend = new Trend();
  for (const sample of samplesMs) {
    trend.recordMs(sample);
  }
  return trend;
};

/** Trends inherit the histogram's ≤0.1 % bucket error, upwards only. */
const expectWithinBound = (measured: number | undefined, exactMs: number): void => {
  expect(measured).toBeGreaterThanOrEqual(exactMs);
  expect(measured ?? Number.NaN).toBeLessThanOrEqual(exactMs * 1.001);
};

describe("Trend", () => {
  // Contract run 4: `behindMs` sampled over time, and its max is the answer.
  it("answers max and percentiles for a projection-lag sample series", () => {
    const trend = trendOf([12, 40, 7, 130, 25]);

    expect(trend.count).toBe(5);
    expectWithinBound(trend.minMs, 7);
    expectWithinBound(trend.maxMs, 130);
    expectWithinBound(trend.percentileMs(50), 25);
  });

  it("keeps sub-millisecond resolution", () => {
    const trend = trendOf([0.25, 1.5]);

    expect(trend.minMs).toBe(0.25);
    expect(trend.maxMs).toBe(1.5);
  });

  // `2.007 * 1000` is 2007.0000000000002 in binary floating point, and the histogram rounds up, so
  // without a nanosecond-scale round first this would record 2008 µs and report 2.008 ms. Checked
  // below 2.048 ms, the only range the layout stores exactly — above it bucket width dominates.
  it("does not invent a microsecond out of floating-point noise", () => {
    for (const valueMs of [2.007, 0.001, 1.021, 0.029, 2.047, 1.337]) {
      expect(trendOf([valueMs]).maxMs).toBe(valueMs);
    }
  });

  it("still rounds a genuinely fractional microsecond up", () => {
    expect(trendOf([2.0071]).maxMs).toBe(2.008);
  });

  it("reports no value rather than zero when nothing was recorded", () => {
    const trend = new Trend();

    expect(trend.count).toBe(0);
    expect(trend.minMs).toBeUndefined();
    expect(trend.maxMs).toBeUndefined();
    expect(trend.meanMs).toBeUndefined();
    expect(trend.percentileMs(99)).toBeUndefined();
  });

  it("counts what it clamps at its millisecond ceiling", () => {
    const trend = trendOf([1, MAX_TRACKABLE_MS + 1]);

    expect(trend.overflowCount).toBe(1);
    expect(trend.maxMs).toBe(MAX_TRACKABLE_MS);
  });

  /**
   * Every field, against the accessor it projects. Without this, deleting `/ US_PER_MS` from any
   * one of them publishes microseconds under a millisecond name — `p99Ms: 25000` for a 25 ms
   * trend — behind a green suite, in the number a report prints first.
   */
  it("agrees field for field with the accessors it projects", () => {
    const trend = trendOf([3, 30, 300, 3_000, 30_000]);
    const summary = trend.summaryMs();

    expect(summary?.count).toBe(trend.count);
    expect(summary?.minMs).toBe(trend.minMs);
    expect(summary?.maxMs).toBe(trend.maxMs);
    expect(summary?.meanMs).toBe(trend.meanMs);
    expect(summary?.p50Ms).toBe(trend.percentileMs(50));
    expect(summary?.p95Ms).toBe(trend.percentileMs(95));
    expect(summary?.p99Ms).toBe(trend.percentileMs(99));
    expect(summary?.p999Ms).toBe(trend.percentileMs(99.9));
    expect(summary?.overflowCount).toBe(trend.overflowCount);
    expect(summary?.saturated).toBe(trend.saturated);
  });

  it("reports every percentile in milliseconds, not the microseconds underneath", () => {
    // 1.5 ms is 1500 µs — under the layout's 1 µs-resolution boundary, so it round-trips exactly
    // and a dropped conversion on any rank shows up unmistakably as a 1000× number.
    const summary = trendOf(Array.from({ length: 100 }, () => 1.5)).summaryMs();

    for (const valueMs of [
      summary?.minMs,
      summary?.maxMs,
      summary?.meanMs,
      summary?.p50Ms,
      summary?.p95Ms,
      summary?.p99Ms,
      summary?.p999Ms,
    ]) {
      expect(valueMs).toBe(1.5);
    }
  });

  it("projects a millisecond summary that carries the clamping caveat", () => {
    const trend = trendOf([...Array.from({ length: 999 }, () => 1), 600_000]);
    const summary = trend.summaryMs();

    expect(summary?.count).toBe(1_000);
    expect(summary?.p50Ms).toBe(1);
    expect(summary?.maxMs).toBe(MAX_TRACKABLE_MS);
    expect(summary?.meanMs).toBeCloseTo(68.09, 1);
    expect(summary?.isLowerBound).toBe(true);
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("has no summary when nothing was recorded", () => {
    expect(new Trend().summaryMs()).toBeUndefined();
  });

  it("rejects samples that are not finite and non-negative", () => {
    const trend = new Trend();

    expect(() => {
      trend.recordMs(-1);
    }).toThrow(/Trend\.recordMs/);
    expect(() => {
      trend.recordMs(Number.NaN);
    }).toThrow(RangeError);
  });

  it("complains in its own voice about a value it cannot convert", () => {
    // Finite in ms, Infinity once scaled to µs — the error must name recordMs and the ms value,
    // not surface in Histogram.record's voice about a number the caller never wrote.
    expect(() => {
      new Trend().recordMs(Number.MAX_VALUE);
    }).toThrow(/Trend\.recordMs cannot represent .* ms/);
  });
});

describe("Trend.merge", () => {
  it("equals recording every sample into one trend", () => {
    const left = [1, 2, 3, 400];
    const right = [50, 60, 7_000];

    const merged = trendOf(left).merge(trendOf(right));
    const single = trendOf([...left, ...right]);

    expect(merged.toSnapshot()).toEqual(single.toSnapshot());
    expect(merged.maxMs).toBe(single.maxMs);
  });

  it("leaves both operands untouched and is commutative", () => {
    const left = trendOf([1, 2]);
    const right = trendOf([3]);

    expect(left.merge(right).toSnapshot()).toEqual(right.merge(left).toSnapshot());
    expect(left.count).toBe(2);
    expect(right.count).toBe(1);
  });

  it("round-trips through a structured clone", () => {
    const trend = trendOf([9, 99, 999]);

    const restored = Trend.fromSnapshot(structuredClone(trend.toSnapshot()));

    expect(restored.toSnapshot()).toEqual(trend.toSnapshot());
    expect(restored.maxMs).toBe(trend.maxMs);
  });
});

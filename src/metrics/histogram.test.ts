import { describe, expect, it } from "vitest";
import { Histogram } from "./histogram.ts";
import { COUNTS_LENGTH, countsIndexOf, MAX_TRACKABLE_US } from "./histogram-layout.ts";
import { HistogramInvariantError, indexAtRank } from "./histogram-stats.ts";
import type { HistogramSnapshot } from "./snapshots.ts";

const MAX_BUCKET_COUNT = 2 ** 31 - 1;

const histogramOf = (samples: Iterable<number>): Histogram => {
  const histogram = new Histogram();
  for (const sample of samples) {
    histogram.record(sample);
  }
  return histogram;
};

/** A histogram whose bucket for `valueUs` is already at its Int32 ceiling. */
const brimmingAt = (valueUs: number): Histogram => {
  const counts = new Int32Array(COUNTS_LENGTH);
  counts[countsIndexOf(valueUs)] = MAX_BUCKET_COUNT;
  return Histogram.fromSnapshot({ counts, overflowCount: 0, saturated: false });
};

describe("Histogram, empty", () => {
  const empty = new Histogram();

  it("counts nothing", () => {
    expect(empty.count).toBe(0);
    expect(empty.overflowCount).toBe(0);
    expect(empty.saturated).toBe(false);
  });

  it("reports no value rather than a flattering zero", () => {
    expect(empty.min).toBeUndefined();
    expect(empty.max).toBeUndefined();
    expect(empty.mean).toBeUndefined();
    expect(empty.percentile(50)).toBeUndefined();
    expect(empty.percentile(99.9)).toBeUndefined();
    expect(empty.percentile(0)).toBeUndefined();
    expect(empty.percentile(100)).toBeUndefined();
  });

  it("has no summary at all, rather than a zero-filled one", () => {
    expect(empty.summary()).toBeUndefined();
  });

  it("still validates its arguments", () => {
    expect(() => empty.percentile(101)).toThrow(RangeError);
  });
});

describe("Histogram.record", () => {
  it("tracks count, min, max and mean", () => {
    const histogram = histogramOf([10, 20, 30, 40]);

    expect(histogram.count).toBe(4);
    expect(histogram.min).toBe(10);
    expect(histogram.max).toBe(40);
    expect(histogram.mean).toBe(25);
  });

  it("accepts a zero-microsecond sample", () => {
    const histogram = histogramOf([0]);

    expect(histogram.count).toBe(1);
    expect(histogram.min).toBe(0);
    expect(histogram.max).toBe(0);
  });

  it("rounds a fractional microsecond up, never down", () => {
    const histogram = histogramOf([0.2, 1500.4]);

    expect(histogram.min).toBe(1);
    expect(histogram.max).toBe(1501);
  });

  it("rejects samples that are not finite and non-negative", () => {
    const histogram = new Histogram();

    expect(() => {
      histogram.record(-1);
    }).toThrow(RangeError);
    expect(() => {
      histogram.record(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      histogram.record(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
    expect(histogram.count).toBe(0);
  });

  it("rejects percentile ranks outside 0–100", () => {
    const histogram = histogramOf([1]);

    expect(() => histogram.percentile(-1)).toThrow(RangeError);
    expect(() => histogram.percentile(100.1)).toThrow(RangeError);
    expect(() => histogram.percentile(Number.NaN)).toThrow(RangeError);
  });
});

describe("countsIndexOf", () => {
  it("maps the layout's boundaries where the derivation comment says it does", () => {
    expect(countsIndexOf(0)).toBe(0);
    expect(countsIndexOf(1023)).toBe(1023);
    expect(countsIndexOf(1024)).toBe(1024);
    expect(countsIndexOf(2047)).toBe(2047);
    expect(countsIndexOf(2048)).toBe(2048);
    expect(countsIndexOf(MAX_TRACKABLE_US)).toBe(COUNTS_LENGTH - 1);
  });

  it("refuses values outside its domain instead of aliasing them onto a valid bucket", () => {
    // Math.clz32 coerces through ToUint32, so 2**32 + 5 would otherwise land on the bucket for 5.
    expect(() => countsIndexOf(MAX_TRACKABLE_US + 1)).toThrow(RangeError);
    expect(() => countsIndexOf(2 ** 32 + 5)).toThrow(RangeError);
    expect(() => countsIndexOf(-1)).toThrow(RangeError);
    expect(() => countsIndexOf(1.5)).toThrow(RangeError);
  });
});

describe("Histogram overflow", () => {
  it("counts what it clamps instead of hiding it", () => {
    const histogram = histogramOf([1_000, MAX_TRACKABLE_US + 1, 300_000_000]);

    expect(histogram.count).toBe(3);
    expect(histogram.overflowCount).toBe(2);
    expect(histogram.max).toBe(MAX_TRACKABLE_US);
  });

  it("does not count samples that fit", () => {
    expect(histogramOf([MAX_TRACKABLE_US]).overflowCount).toBe(0);
  });

  it("reports the ceiling as a lower bound for a percentile among clamped samples", () => {
    const histogram = histogramOf([...Array.from({ length: 99 }, () => 1_000), 300_000_000]);

    expect(histogram.percentile(50)).toBe(1_000);
    expect(histogram.percentile(100)).toBe(MAX_TRACKABLE_US);
    expect(histogram.overflowCount).toBe(1);
  });
});

describe("Histogram.summary", () => {
  it("projects the whole distribution in one frozen object", () => {
    const summary = histogramOf(
      Array.from({ length: 1_000 }, (_unused, step) => step + 1),
    ).summary();

    expect(summary?.count).toBe(1_000);
    expect(summary?.min).toBe(1);
    expect(summary?.max).toBe(1_000);
    expect(summary?.p50).toBe(500);
    expect(summary?.p95).toBe(950);
    expect(summary?.p99).toBe(990);
    expect(summary?.p999).toBe(999);
    expect(summary?.isLowerBound).toBe(false);
    expect(Object.isFrozen(summary)).toBe(true);
  });

  // The failure this projection exists to make impossible to miss: one clamped sample drags the
  // mean 8.8× below the truth, and every number involved stays perfectly plausible.
  it("flags a distribution whose tail was clamped, where the mean alone would lie", () => {
    const tenMinutesUs = 600_000_000;
    const summary = histogramOf([
      ...Array.from({ length: 999 }, () => 1_000),
      tenMinutesUs,
    ]).summary();
    const trueMeanUs = (999 * 1_000 + tenMinutesUs) / 1_000;

    expect(trueMeanUs).toBeCloseTo(600_999, 0);
    expect(summary?.mean).toBeCloseTo(68_091.48, 1);
    expect(summary?.mean).toBeLessThan(trueMeanUs / 8);
    expect(summary?.max).toBe(MAX_TRACKABLE_US);
    expect(summary?.overflowCount).toBe(1);
    expect(summary?.isLowerBound).toBe(true);
  });

  it("agrees with the accessors it projects", () => {
    const histogram = histogramOf([5, 50, 500, 5_000, 50_000]);
    const summary = histogram.summary();

    expect(summary?.min).toBe(histogram.min);
    expect(summary?.max).toBe(histogram.max);
    expect(summary?.mean).toBe(histogram.mean);
    expect(summary?.p50).toBe(histogram.percentile(50));
    expect(summary?.p95).toBe(histogram.percentile(95));
    expect(summary?.p99).toBe(histogram.percentile(99));
    expect(summary?.p999).toBe(histogram.percentile(99.9));
    expect(summary?.count).toBe(histogram.count);
    expect(summary?.overflowCount).toBe(histogram.overflowCount);
    expect(summary?.saturated).toBe(histogram.saturated);
  });

  it("reports saturation rather than a hardcoded false", () => {
    const saturated = brimmingAt(1_000);
    saturated.record(1_000);

    expect(saturated.saturated).toBe(true);
    expect(saturated.summary()?.saturated).toBe(true);
  });
});

describe("Histogram bucket saturation", () => {
  it("drops the sample and latches the flag rather than wrapping the count negative", () => {
    const histogram = brimmingAt(1_000);

    expect(histogram.count).toBe(MAX_BUCKET_COUNT);
    expect(histogram.saturated).toBe(false);

    histogram.record(1_000);

    expect(histogram.saturated).toBe(true);
    expect(histogram.count).toBe(MAX_BUCKET_COUNT);
    expect(histogram.max).toBe(1_000);
  });

  it("clamps a merge that would overflow a bucket, and says so", () => {
    const merged = brimmingAt(1_000).merge(brimmingAt(1_000));

    expect(merged.saturated).toBe(true);
    expect(merged.count).toBe(MAX_BUCKET_COUNT);
  });

  it("carries the flag through a snapshot round-trip", () => {
    const saturated = brimmingAt(1_000);
    saturated.record(1_000);

    expect(Histogram.fromSnapshot(saturated.toSnapshot()).saturated).toBe(true);
  });

  it("keeps the flag set when merged with a clean histogram, from either side", () => {
    const saturated = brimmingAt(1_000);
    saturated.record(1_000);

    expect(saturated.merge(new Histogram()).saturated).toBe(true);
    expect(new Histogram().merge(saturated).saturated).toBe(true);
  });
});

describe("Histogram snapshots", () => {
  it("round-trips losslessly", () => {
    const original = histogramOf([1, 42, 5_000, 1_234_567, MAX_TRACKABLE_US + 1]);

    const restored = Histogram.fromSnapshot(original.toSnapshot());

    expect(restored.toSnapshot()).toEqual(original.toSnapshot());
    expect(restored.count).toBe(original.count);
    expect(restored.overflowCount).toBe(original.overflowCount);
    expect(restored.summary()).toEqual(original.summary());
  });

  it("survives structuredClone, which is how it reaches the main thread", () => {
    const original = histogramOf([7, 700, 70_000, 7_000_000]);

    const cloned = Histogram.fromSnapshot(structuredClone(original.toSnapshot()));

    expect(cloned.toSnapshot()).toEqual(original.toSnapshot());
  });

  it("does not alias the buckets it hands out", () => {
    const histogram = histogramOf([1_000]);
    const snapshot = histogram.toSnapshot();

    histogram.record(1_000);

    expect(Histogram.fromSnapshot(snapshot).count).toBe(1);
  });

  it("refuses a bucket array of the wrong length rather than reading it short", () => {
    const wrongLength: HistogramSnapshot = {
      counts: new Int32Array(COUNTS_LENGTH - 1),
      overflowCount: 0,
      saturated: false,
    };

    expect(() => Histogram.fromSnapshot(wrongLength)).toThrow(/buckets/);
  });
});

describe("histogram statistics invariants", () => {
  it("refuses a rank the buckets cannot answer, with a typed error", () => {
    // Only reachable if a cached sample count and its bucket array ever went out of step; the
    // throw is the tripwire for that, so it is worth pinning rather than leaving unexercised.
    expect(() => indexAtRank(new Int32Array(COUNTS_LENGTH), 1)).toThrow(HistogramInvariantError);
    expect(() => indexAtRank(new Int32Array(COUNTS_LENGTH), 1)).toThrow(/rank 1/);
  });

  it("answers a rank the buckets can", () => {
    const counts = new Int32Array(COUNTS_LENGTH);
    counts[7] = 3;

    expect(indexAtRank(counts, 1)).toBe(7);
    expect(indexAtRank(counts, 3)).toBe(7);
  });
});

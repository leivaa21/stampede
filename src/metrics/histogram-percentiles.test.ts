import { describe, expect, it } from "vitest";
import { Histogram } from "./histogram.ts";

/** The bound D1-02 publishes. The layout's worst case is 1/1024 ≈ 0.098 %, just inside it. */
const ERROR_BOUND = 0.001;

const RANKS = [0, 50, 90, 95, 99, 99.9, 100];

const histogramOf = (samples: Iterable<number>): Histogram => {
  const histogram = new Histogram();
  for (const sample of samples) {
    histogram.record(sample);
  }
  return histogram;
};

const rangeOf = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset);

/**
 * Textbook **nearest-rank** percentile — the `ceil(p/100 · N)`-th smallest sample — deliberately
 * *not* the round-to-nearest rule `Histogram` inherits from HDR. An oracle that re-derived the
 * implementation's own formula could not catch a wrong formula; this one can.
 *
 * The price is that the two rules select *adjacent* samples wherever `p·N` lands near an integer
 * (at p99.9 of 1000 samples, one picks the 999th and the other the 1000th). On the dense sets
 * below those neighbours differ by well under the error bound, so the tolerance assertions still
 * hold — but "never reports below the truth" cannot be asserted against a rank the histogram did
 * not claim to be answering. That property is pinned on `min`/`max` instead, where no rank rule is
 * involved, and the rank rule itself is pinned by hand-written expectations on small sets.
 */
const exactPercentile = (samples: readonly number[], rank: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const nearestRank = Math.min(sorted.length, Math.max(1, Math.ceil((rank / 100) * sorted.length)));
  const value = sorted[nearestRank - 1];
  if (value === undefined) {
    throw new Error(`no sample at rank ${String(rank)} of ${String(sorted.length)}`);
  }
  return value;
};

const reported = (histogram: Histogram, rank: number): number => {
  const value = histogram.percentile(rank);
  if (value === undefined) {
    throw new Error(`no percentile at rank ${String(rank)}`);
  }
  return value;
};

const definitely = (value: number | undefined): number => {
  if (value === undefined) {
    throw new Error("expected a recorded value");
  }
  return value;
};

// Every sample below the layout's 1 µs-resolution boundary is stored exactly, so a zero sample is
// reported as zero and never divides here.
const relativeError = (measured: number, exact: number): number =>
  Math.abs(measured - exact) / exact;

describe("Histogram percentiles, known fixed set", () => {
  const samples = rangeOf(1, 10);
  const histogram = histogramOf(samples);

  // Hand-checked against the sorted set [1…10], no formula in sight: these pin the rank rule
  // itself, which a computed oracle structurally cannot.
  it("is exact below the layout's 1 µs-resolution boundary", () => {
    expect(histogram.percentile(0)).toBe(1);
    expect(histogram.percentile(50)).toBe(5);
    expect(histogram.percentile(90)).toBe(9);
    expect(histogram.percentile(100)).toBe(10);
    expect(histogram.min).toBe(1);
    expect(histogram.max).toBe(10);
    expect(histogram.mean).toBe(5.5);
  });

  it("selects the rank a sorted list would, on a set with duplicates", () => {
    // [1,1,1,1,1,1,1,1,1,9] — p50 must be 1, not the mean, and only p100 reaches the outlier.
    const skewed = histogramOf([...Array.from({ length: 9 }, () => 1), 9]);

    expect(skewed.percentile(0)).toBe(1);
    expect(skewed.percentile(50)).toBe(1);
    expect(skewed.percentile(90)).toBe(1);
    expect(skewed.percentile(100)).toBe(9);
  });

  it("agrees with the independent oracle at every rank", () => {
    for (const rank of RANKS) {
      expect(reported(histogram, rank)).toBe(exactPercentile(samples, rank));
    }
  });
});

describe("Histogram percentiles, uniform distribution", () => {
  const samples = rangeOf(1, 10_000);
  const histogram = histogramOf(samples);

  it("lands on the expected quantiles within the error bound", () => {
    for (const rank of RANKS) {
      const exact = exactPercentile(samples, rank);

      expect(relativeError(reported(histogram, rank), exact)).toBeLessThanOrEqual(ERROR_BOUND);
    }
  });

  it("keeps the mean inside the bound too", () => {
    const exactMean = samples.reduce((total, sample) => total + sample, 0) / samples.length;

    expect(relativeError(definitely(histogram.mean), exactMean)).toBeLessThanOrEqual(ERROR_BOUND);
  });
});

describe("Histogram percentiles across magnitudes", () => {
  // 1 µs to 60 s — the full range the layout claims, one decade at a time.
  const MAGNITUDES = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 30_000_000];

  /** 1000 samples spread over [magnitude, 2·magnitude) — one whole octave of the layout. */
  const octaveAround = (magnitude: number): number[] =>
    Array.from({ length: 1_000 }, (_unused, step) =>
      Math.round(magnitude + (step * magnitude) / 1_000),
    );

  it.each(MAGNITUDES)("holds the error bound at every rank around %i µs", (magnitude) => {
    const samples = octaveAround(magnitude);
    const histogram = histogramOf(samples);

    expect(histogram.count).toBe(samples.length);
    expect(histogram.overflowCount).toBe(0);

    for (const rank of RANKS) {
      const exact = exactPercentile(samples, rank);

      expect(relativeError(reported(histogram, rank), exact)).toBeLessThanOrEqual(ERROR_BOUND);
    }
  });

  /**
   * The honesty half of the bound, on the two statistics no rank rule can blur: whatever bucket a
   * sample lands in, the value read back sits at or above it, by less than 0.1 %.
   */
  it.each(MAGNITUDES)("never reports below the truth around %i µs", (magnitude) => {
    const samples = octaveAround(magnitude);
    const histogram = histogramOf(samples);
    const smallest = Math.min(...samples);
    const largest = Math.max(...samples);

    expect(definitely(histogram.min)).toBeGreaterThanOrEqual(smallest);
    expect(definitely(histogram.max)).toBeGreaterThanOrEqual(largest);
    expect(relativeError(definitely(histogram.min), smallest)).toBeLessThanOrEqual(ERROR_BOUND);
    expect(relativeError(definitely(histogram.max), largest)).toBeLessThanOrEqual(ERROR_BOUND);
  });

  it("never reports a single recorded sample below its own value", () => {
    for (let value = 1; value <= 30_000_000; value = Math.ceil(value * 1.37)) {
      const histogram = histogramOf([value]);

      expect(definitely(histogram.max)).toBeGreaterThanOrEqual(value);
      expect(relativeError(definitely(histogram.max), value)).toBeLessThanOrEqual(ERROR_BOUND);
    }
  });
});

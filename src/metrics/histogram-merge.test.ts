import { describe, expect, it } from "vitest";
import { Histogram } from "./histogram.ts";
import { MAX_TRACKABLE_US } from "./histogram-layout.ts";

/** xorshift32 — deterministic, so a failing merge property is reproducible from the seed alone. */
const pseudoRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
};

const samplesFrom = (seed: number, count: number): number[] => {
  const next = pseudoRandom(seed);
  return Array.from({ length: count }, () => 1 + (next() % 5_000_000));
};

const histogramOf = (samples: Iterable<number>): Histogram => {
  const histogram = new Histogram();
  for (const sample of samples) {
    histogram.record(sample);
  }
  return histogram;
};

const permutations = <T>(items: readonly T[]): T[][] => {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
};

const mergeAll = (histograms: readonly Histogram[]): Histogram =>
  histograms.reduce((merged, histogram) => merged.merge(histogram), new Histogram());

describe("Histogram.merge", () => {
  it("leaves both operands untouched", () => {
    const left = histogramOf([1, 2, 3]);
    const right = histogramOf([4, 5, 6]);
    const leftBefore = left.toSnapshot();
    const rightBefore = right.toSnapshot();

    const merged = left.merge(right);

    expect(left.toSnapshot()).toEqual(leftBefore);
    expect(right.toSnapshot()).toEqual(rightBefore);
    expect(merged.count).toBe(6);
  });

  it("keeps merging into the result away from the operands", () => {
    const source = histogramOf([1, 2, 3]);

    const merged = source.merge(new Histogram());
    merged.record(4);

    expect(source.count).toBe(3);
    expect(merged.count).toBe(4);
  });

  it("adds overflow counts", () => {
    const left = histogramOf([MAX_TRACKABLE_US + 1, 10]);
    const right = histogramOf([MAX_TRACKABLE_US * 2]);

    const merged = left.merge(right);

    expect(merged.overflowCount).toBe(2);
    expect(merged.count).toBe(3);
  });

  it("propagates saturation from either side", () => {
    const saturated = Histogram.fromSnapshot({ ...histogramOf([1]).toSnapshot(), saturated: true });

    expect(saturated.merge(new Histogram()).saturated).toBe(true);
    expect(new Histogram().merge(saturated).saturated).toBe(true);
  });

  it("is commutative", () => {
    const left = histogramOf(samplesFrom(1, 500));
    const right = histogramOf(samplesFrom(2, 700));

    expect(left.merge(right).toSnapshot()).toEqual(right.merge(left).toSnapshot());
  });

  it("is associative", () => {
    const a = histogramOf(samplesFrom(1, 300));
    const b = histogramOf(samplesFrom(2, 300));
    const c = histogramOf(samplesFrom(3, 300));

    expect(a.merge(b).merge(c).toSnapshot()).toEqual(a.merge(b.merge(c)).toSnapshot());
  });

  it("gives the same result for every ordering of four histograms", () => {
    const histograms = [1, 2, 3, 4].map((seed) => histogramOf(samplesFrom(seed, 250)));
    const orderings = permutations(histograms);
    const expected = mergeAll(histograms).toSnapshot();

    expect(orderings).toHaveLength(24);
    for (const ordering of orderings) {
      expect(mergeAll(ordering).toSnapshot()).toEqual(expected);
    }
  });
});

describe("Histogram merge across workers", () => {
  // The property the whole worker architecture rests on: splitting a run across workers and
  // merging their histograms must be indistinguishable from never having split it (D1-03).
  it("merging N per-worker histograms equals recording every sample into one", () => {
    const samples = samplesFrom(42, 10_000);
    const workerCount = 4;
    const perWorker = Array.from({ length: workerCount }, (_, worker) =>
      histogramOf(samples.filter((_sample, index) => index % workerCount === worker)),
    );

    const merged = mergeAll(perWorker);
    const single = histogramOf(samples);

    expect(merged.toSnapshot()).toEqual(single.toSnapshot());
    expect(merged.count).toBe(single.count);
    expect(merged.min).toBe(single.min);
    expect(merged.max).toBe(single.max);
    expect(merged.mean).toBe(single.mean);
    for (const rank of [0, 50, 95, 99, 99.9, 100]) {
      expect(merged.percentile(rank)).toBe(single.percentile(rank));
    }
  });

  it("holds when workers recorded wildly different magnitudes", () => {
    const slow = samplesFrom(7, 100).map((sample) => sample * 10);
    const fast = samplesFrom(8, 900).map((sample) => sample % 900);

    const merged = histogramOf(slow).merge(histogramOf(fast));
    const single = histogramOf([...slow, ...fast]);

    expect(merged.toSnapshot()).toEqual(single.toSnapshot());
  });
});

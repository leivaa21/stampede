import { COUNTS_LENGTH, highestEquivalentValueAt, midpointValueAt } from "./histogram-layout.ts";

/**
 * Reading statistics back out of a bucket array — the half of a histogram that only ever looks.
 *
 * Split from `Histogram` because accumulating into buckets and interrogating them are different
 * jobs with different risks: everything here is a pure function of `(counts, totalCount)`, so a
 * percentile can be reasoned about without knowing anything about recording, merging or clamping.
 *
 * Each function walks the array once. A `summary()` therefore walks it a handful of times, which
 * is 17 408 additions per statistic — irrelevant against the ~1 Hz the main thread re-aggregates
 * at, and not worth trading the clarity of one loop per question.
 */

/**
 * A rank was requested that the buckets cannot answer — the cached sample count and the bucket
 * array have gone out of step. Typed rather than a bare `Error` so a caller can tell an internal
 * corruption apart from bad input (workspace CLAUDE.md §5).
 */
export class HistogramInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistogramInvariantError";
  }
}

/** Index of the bucket holding the `rank`-th sample (1-based). */
export const indexAtRank = (counts: Int32Array, rank: number): number => {
  let seen = 0;
  for (let index = 0; index < COUNTS_LENGTH; index += 1) {
    seen += counts[index] ?? 0;
    if (seen >= rank) {
      return index;
    }
  }
  throw new HistogramInvariantError(
    `No sample at rank ${String(rank)}: the buckets hold only ${String(seen)}`,
  );
};

/**
 * Value at a percentile rank, using HDR's rule — round the rank to nearest, never below the first
 * sample — and reporting the top of the bucket it lands in.
 */
export const valueAtRank = (counts: Int32Array, totalCount: number, rank: number): number =>
  highestEquivalentValueAt(
    indexAtRank(counts, Math.max(1, Math.floor((rank / 100) * totalCount + 0.5))),
  );

/** Bucket midpoints weighted by their counts — midpoints, so the average is not inflated. */
export const meanOf = (counts: Int32Array, totalCount: number): number => {
  let weighted = 0;
  for (let index = 0; index < COUNTS_LENGTH; index += 1) {
    const bucketCount = counts[index] ?? 0;
    if (bucketCount !== 0) {
      weighted += midpointValueAt(index) * bucketCount;
    }
  }
  return weighted / totalCount;
};

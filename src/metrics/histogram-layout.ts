/**
 * The fixed HDR-style bucket layout every histogram in stampede shares.
 *
 * Fixed is the whole point: two histograms with the same layout merge by elementwise addition,
 * which is exact, associative and commutative — so whichever worker happens to finish first can
 * never change a published number (docs/decisions.md, D1-02).
 *
 * The arithmetic, so the bucket math can be checked without re-deriving HDR from scratch:
 *
 *   3 significant digits    → the largest value still resolved to a single µs is 2·10³ = 2000
 *   next power of two       → SUB_BUCKET_COUNT      = 2^ceil(log₂ 2000) = 2^11 = 2048
 *   half of it is an octave → SUB_BUCKET_HALF_COUNT = 2^10 = 1024 counts per power-of-two octave
 *   ceiling ≥ 60 s          → the first octave boundary past 60 s is 2^26 µs ≈ 67.1 s
 *                             → BUCKET_COUNT = 16 exponent buckets (b = 0…15)
 *   storage                 → (16 + 1) · 1024 = 17 408 Int32 = 69 632 bytes ≈ 68 KiB
 *
 * Bucket 0 holds [0, 2048) µs at 1 µs resolution — it is the only bucket using both halves of the
 * sub-bucket range, which is where the "+ 1" comes from. Bucket b > 0 holds the octave
 * [1024·2^b, 2048·2^b) in 1024 steps of 2^b, so a step is never worse than 1/1024 ≈ 0.098 % of the
 * value that lands on it. That is the ≤0.1 % bound D1-02 publishes, and it holds at every
 * magnitude from 1 µs to the ceiling.
 *
 * 68 KiB per histogram sits inside the ~108 KB per-histogram budget the decision record set aside;
 * packing two half-buckets into bucket 0 is what buys the difference.
 */

const SUB_BUCKET_HALF_COUNT_MAGNITUDE = 10;
const SUB_BUCKET_HALF_COUNT = 1 << SUB_BUCKET_HALF_COUNT_MAGNITUDE;
const BUCKET_COUNT = 16;

/** Number of Int32 counters backing one histogram. */
export const COUNTS_LENGTH = (BUCKET_COUNT + 1) * SUB_BUCKET_HALF_COUNT;

/** Ceiling of the layout, in µs (≈67.1 s). Larger samples are clamped here *and* counted. */
export const MAX_TRACKABLE_US = SUB_BUCKET_HALF_COUNT * 2 ** BUCKET_COUNT - 1;

/**
 * Counts index for a sample. `valueUs` must be an integer in `[0, MAX_TRACKABLE_US]` — clamping is
 * the caller's job precisely because a clamp is also something that has to be counted.
 *
 * The range is asserted rather than assumed: `Math.clz32` coerces through `ToUint32`, so an
 * out-of-domain value does not fail here, it silently aliases onto a valid bucket (`2³² + 5` would
 * land on 5). Today only `record`'s clamp stands between that and a published number.
 */
export const countsIndexOf = (valueUs: number): number => {
  if (!Number.isInteger(valueUs) || valueUs < 0 || valueUs > MAX_TRACKABLE_US) {
    throw new RangeError(
      `countsIndexOf expects an integer in [0, ${String(MAX_TRACKABLE_US)}], got ${String(valueUs)}`,
    );
  }
  const bucketIndex = Math.max(0, 31 - Math.clz32(valueUs) - SUB_BUCKET_HALF_COUNT_MAGNITUDE);
  const subBucketIndex = valueUs >>> bucketIndex;
  return (
    ((bucketIndex + 1) << SUB_BUCKET_HALF_COUNT_MAGNITUDE) + subBucketIndex - SUB_BUCKET_HALF_COUNT
  );
};

/**
 * Counts indices 0…1023 are bucket 0's *packed lower half* — the sub-buckets stored without the
 * `+ SUB_BUCKET_HALF_COUNT` offset every other index carries. Bucket 0 itself spans indices
 * 0…2047; this tests for the packed half of it, not for the bucket.
 */
const isPackedLowerHalf = (index: number): boolean => index < SUB_BUCKET_HALF_COUNT;

const bucketIndexAt = (index: number): number =>
  isPackedLowerHalf(index) ? 0 : (index >>> SUB_BUCKET_HALF_COUNT_MAGNITUDE) - 1;

/** Width of the value range sharing `index` — 1 µs in bucket 0, 2^b µs in bucket b. */
const equivalentRangeAt = (index: number): number => 1 << bucketIndexAt(index);

/** Smallest value that lands in `index`. */
const lowestEquivalentValueAt = (index: number): number => {
  const subBucketIndex =
    (index & (SUB_BUCKET_HALF_COUNT - 1)) + (isPackedLowerHalf(index) ? 0 : SUB_BUCKET_HALF_COUNT);
  return subBucketIndex << bucketIndexAt(index);
};

/**
 * The value reported for a sample that landed in `index` — the *top* of its bucket, never the
 * bottom. A reported latency is then guaranteed to sit at or above the truth, and over-reporting
 * by <0.1 % is the honest direction for a tool whose pitch is "prove your numbers" (D1-02).
 */
export const highestEquivalentValueAt = (index: number): number =>
  lowestEquivalentValueAt(index) + equivalentRangeAt(index) - 1;

/**
 * The value weighting `index` in a mean. Averaging bucket tops would inflate every mean by half a
 * step, so means use the midpoint instead — exact for the 1 µs-resolution buckets.
 */
export const midpointValueAt = (index: number): number =>
  lowestEquivalentValueAt(index) + (equivalentRangeAt(index) >>> 1);

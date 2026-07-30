import {
  COUNTS_LENGTH,
  countsIndexOf,
  highestEquivalentValueAt,
  MAX_TRACKABLE_US,
} from "./histogram-layout.ts";
import { indexAtRank, meanOf, valueAtRank } from "./histogram-stats.ts";
import { SnapshotFormatError } from "./narrow.ts";
import type { HistogramSnapshot } from "./snapshots.ts";
import type { HistogramSummary } from "./summaries.ts";
import { assertPercentileRank, assertSample } from "./validate.ts";

/**
 * An Int32 bucket saturates at 2³¹ − 1 samples — ~2.1 billion samples landing in the *same*
 * bucket, roughly 36 minutes at a million identical-latency samples per second. Past that the
 * sample is dropped and `saturated` latches true, because wrapping a count negative would turn
 * every percentile derived from it into nonsense, silently.
 */
const MAX_BUCKET_COUNT = 2 ** 31 - 1;

/**
 * A fixed-layout HDR-style histogram of microsecond samples — see `histogram-layout.ts` for the
 * bucket arithmetic and the ≤0.1 % error bound.
 *
 * Pure by construction: no clock, no I/O. The caller decides what a sample means and when it was
 * taken. `merge` returns a new histogram and never touches either operand, so aggregating across
 * workers is associative and commutative (D1-02).
 *
 * **Two different error regimes, and the difference matters.** While every sample fits the layout,
 * `min`, `max` and `percentile` report the top of the sample's bucket, so a reported latency sits
 * at or above the truth by less than 0.1 % — bounded, and in the honest direction. Once
 * `overflowCount > 0` that guarantee is gone: clamped samples are indistinguishable from samples
 * at the ceiling, so `max`, `mean` and any percentile reaching the tail **understate** the truth
 * by an unbounded margin. Prefer `summary()`, which carries that caveat as `isLowerBound` on the
 * same object as the numbers.
 *
 * Accessors return `undefined` when nothing was recorded rather than 0: a p99 of "0 ms" for a
 * scenario that never ran is exactly the flattering lie this tool exists to avoid.
 */
export class Histogram {
  readonly #counts = new Int32Array(COUNTS_LENGTH);
  #count = 0;
  #overflowCount = 0;
  #saturated = false;

  /**
   * Rebuilds from an already-narrowed snapshot. Untrusted input goes through
   * `parseRegistrySnapshot` first; the length check here is the one mistake that would otherwise
   * corrupt silently rather than throw.
   */
  static fromSnapshot(snapshot: HistogramSnapshot): Histogram {
    if (snapshot.counts.length !== COUNTS_LENGTH) {
      throw new SnapshotFormatError(
        `Histogram snapshot must have ${String(COUNTS_LENGTH)} buckets, got ${String(snapshot.counts.length)}`,
      );
    }
    const restored = new Histogram();
    restored.#addCounts(snapshot.counts);
    restored.#overflowCount = snapshot.overflowCount;
    // `||=`, not `=`: identical today, because `#addCounts` cannot saturate a *fresh* histogram
    // (an Int32Array cannot hold more than the ceiling it clamps at). Kept as a latch so that
    // stays true by construction if the restore path ever grows a step that can set the flag.
    restored.#saturated ||= snapshot.saturated;
    return restored;
  }

  /**
   * @param valueUs microseconds. Fractions round **up**: the instrument's 1 µs resolution floor
   * must not be able to make a target look faster than it was.
   */
  record(valueUs: number): void {
    assertSample(valueUs, "Histogram.record");

    const microseconds = Math.ceil(valueUs);
    const isOverflow = microseconds > MAX_TRACKABLE_US;
    const index = countsIndexOf(isOverflow ? MAX_TRACKABLE_US : microseconds);
    const bucketCount = this.#counts[index] ?? 0;

    if (bucketCount === MAX_BUCKET_COUNT) {
      this.#saturated = true;
      return;
    }

    this.#counts[index] = bucketCount + 1;
    this.#count += 1;
    if (isOverflow) {
      this.#overflowCount += 1;
    }
  }

  /** Elementwise addition into a new histogram; neither operand is touched. */
  merge(other: Histogram): Histogram {
    const merged = new Histogram();
    merged.#addCounts(this.#counts);
    merged.#addCounts(other.#counts);
    merged.#overflowCount = this.#overflowCount + other.#overflowCount;
    merged.#saturated ||= this.#saturated || other.#saturated;
    return merged;
  }

  toSnapshot(): HistogramSnapshot {
    // Copied, not aliased: the main thread holds on to each worker's latest snapshot and re-merges
    // it on every update (D1-03), so it must not share buckets that are still being written to.
    return {
      counts: new Int32Array(this.#counts),
      overflowCount: this.#overflowCount,
      saturated: this.#saturated,
    };
  }

  /**
   * Everything the reporter and the thresholds need, frozen, with `isLowerBound` travelling
   * alongside the numbers it qualifies. `undefined` when nothing was recorded — see `summaries.ts`.
   */
  summary(): HistogramSummary | undefined {
    if (this.#count === 0) {
      return undefined;
    }
    return Object.freeze({
      count: this.#count,
      min: this.#minValue(),
      max: this.#maxValue(),
      mean: meanOf(this.#counts, this.#count),
      p50: valueAtRank(this.#counts, this.#count, 50),
      p95: valueAtRank(this.#counts, this.#count, 95),
      p99: valueAtRank(this.#counts, this.#count, 99),
      p999: valueAtRank(this.#counts, this.#count, 99.9),
      overflowCount: this.#overflowCount,
      saturated: this.#saturated,
      isLowerBound: this.#overflowCount > 0,
    });
  }

  get count(): number {
    return this.#count;
  }

  /** Samples that exceeded the layout ceiling. They are in `count` too, clamped to the ceiling. */
  get overflowCount(): number {
    return this.#overflowCount;
  }

  /** True once a bucket hit its Int32 ceiling and samples started being dropped. */
  get saturated(): boolean {
    return this.#saturated;
  }

  get min(): number | undefined {
    return this.#count === 0 ? undefined : this.#minValue();
  }

  /** Understates the truth when `overflowCount > 0` — see the class docstring. */
  get max(): number | undefined {
    return this.#count === 0 ? undefined : this.#maxValue();
  }

  /**
   * Understates the truth when `overflowCount > 0`, and by the widest margin of any accessor here:
   * a clamped sample contributes the ceiling instead of its real value, so one 10-minute request
   * among a thousand 1 ms ones reads as a 68 ms mean rather than 601 ms.
   */
  get mean(): number | undefined {
    return this.#count === 0 ? undefined : meanOf(this.#counts, this.#count);
  }

  /**
   * Value at `rank` (0–100), e.g. `percentile(99.9)`.
   *
   * Overflowed samples all sit in the top bucket, so when `overflowCount > 0` a rank that lands
   * among them returns the layout ceiling — a **lower bound** on the true percentile, not the
   * value. That is why `overflowCount` is reported next to the percentiles instead of being
   * absorbed: a silently clamped p99 is a lie (D1-02).
   */
  percentile(rank: number): number | undefined {
    assertPercentileRank(rank);
    return this.#count === 0 ? undefined : valueAtRank(this.#counts, this.#count, rank);
  }

  #minValue(): number {
    return highestEquivalentValueAt(indexAtRank(this.#counts, 1));
  }

  #maxValue(): number {
    return highestEquivalentValueAt(indexAtRank(this.#counts, this.#count));
  }

  #addCounts(counts: Int32Array): void {
    for (let index = 0; index < COUNTS_LENGTH; index += 1) {
      const addend = counts[index] ?? 0;
      if (addend === 0) {
        continue;
      }
      const current = this.#counts[index] ?? 0;
      const total = current + addend;
      const stored = Math.min(total, MAX_BUCKET_COUNT);
      this.#saturated ||= stored !== total;
      this.#counts[index] = stored;
      this.#count += stored - current;
    }
  }
}

import { Histogram } from "./histogram.ts";
import { MAX_TRACKABLE_US } from "./histogram-layout.ts";
import type { HistogramSnapshot } from "./snapshots.ts";
import type { TrendSummary } from "./summaries.ts";
import { assertSample } from "./validate.ts";

const US_PER_MS = 1000;
const NS_PER_US = 1000;

/** Ceiling of a trend, in milliseconds (≈67 s). Samples above it are clamped *and* counted. */
export const MAX_TRACKABLE_MS = MAX_TRACKABLE_US / US_PER_MS;

const toMs = (valueUs: number | undefined): number | undefined =>
  valueUs === undefined ? undefined : valueUs / US_PER_MS;

/**
 * `valueMs * 1000` is not exact in binary floating point — `2.007` becomes `2007.0000000000002` —
 * and the histogram rounds fractions up, so that noise would cost a whole spurious microsecond and
 * push the end-to-end error past the 1/1024 bound the layout advertises. Rounding at nanosecond
 * scale first, far below the instrument's resolution, leaves the histogram's own rule to do the
 * only rounding that is real.
 */
const toMicroseconds = (valueMs: number): number =>
  Math.round(valueMs * US_PER_MS * NS_PER_US) / NS_PER_US;

/**
 * A user-recordable distribution in **milliseconds** — open-ticket's contract run 4 samples
 * `behindMs` over time and wants its max and its percentiles, which a counter cannot express
 * (docs/design/m1.md).
 *
 * It is a `Histogram` underneath: same fixed layout, same lossless elementwise merge, no second
 * data structure to get wrong. The unit is the only difference, so every member here carries an
 * `Ms` suffix where `Histogram`'s carries µs — a caller cannot hand one the other's unit by
 * accident, and the two live in separate namespaces inside a scenario for the same reason.
 *
 * The overflow caveat is inherited whole: past the ceiling `maxMs` and `meanMs` understate the
 * truth without bound. `summaryMs()` carries it as `isLowerBound`.
 */
export class Trend {
  #samples = new Histogram();

  static fromSnapshot(snapshot: HistogramSnapshot): Trend {
    const restored = new Trend();
    restored.#samples = Histogram.fromSnapshot(snapshot);
    return restored;
  }

  recordMs(valueMs: number): void {
    assertSample(valueMs, "Trend.recordMs");
    const microseconds = toMicroseconds(valueMs);
    // A finite millisecond value can still overflow to Infinity in microseconds. Caught here so
    // the error names `recordMs` and the value the caller actually passed, rather than surfacing
    // in `Histogram.record`'s voice about a number the caller never wrote.
    if (!Number.isFinite(microseconds)) {
      throw new RangeError(`Trend.recordMs cannot represent ${String(valueMs)} ms in microseconds`);
    }
    this.#samples.record(microseconds);
  }

  /** Elementwise addition into a new trend; neither operand is touched. */
  merge(other: Trend): Trend {
    const merged = new Trend();
    merged.#samples = this.#samples.merge(other.#samples);
    return merged;
  }

  toSnapshot(): HistogramSnapshot {
    return this.#samples.toSnapshot();
  }

  /** The millisecond-facing projection. `undefined` when nothing was recorded. */
  summaryMs(): TrendSummary | undefined {
    const summary = this.#samples.summary();
    if (summary === undefined) {
      return undefined;
    }
    return Object.freeze({
      count: summary.count,
      minMs: summary.min / US_PER_MS,
      maxMs: summary.max / US_PER_MS,
      meanMs: summary.mean / US_PER_MS,
      p50Ms: summary.p50 / US_PER_MS,
      p95Ms: summary.p95 / US_PER_MS,
      p99Ms: summary.p99 / US_PER_MS,
      p999Ms: summary.p999 / US_PER_MS,
      overflowCount: summary.overflowCount,
      saturated: summary.saturated,
      isLowerBound: summary.isLowerBound,
    });
  }

  get count(): number {
    return this.#samples.count;
  }

  get overflowCount(): number {
    return this.#samples.overflowCount;
  }

  get saturated(): boolean {
    return this.#samples.saturated;
  }

  get minMs(): number | undefined {
    return toMs(this.#samples.min);
  }

  /** Understates the truth when `overflowCount > 0`. */
  get maxMs(): number | undefined {
    return toMs(this.#samples.max);
  }

  /** Understates the truth when `overflowCount > 0`, by the widest margin — see `Histogram.mean`. */
  get meanMs(): number | undefined {
    return toMs(this.#samples.mean);
  }

  percentileMs(rank: number): number | undefined {
    return toMs(this.#samples.percentile(rank));
  }
}

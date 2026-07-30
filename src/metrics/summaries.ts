/**
 * Read-only projections of a distribution — the shape the reporter, the TUI and the threshold
 * predicates consume.
 *
 * The point of a projection rather than loose accessors is `isLowerBound`. Overflowed samples are
 * clamped into the top bucket, so once one exists, `max`, `mean` and any percentile reaching into
 * the tail **understate the truth, without bound** — a ten-minute request read back as 67 s. That
 * caveat has to travel *with* the numbers instead of depending on the reporter remembering to look
 * at `overflowCount` separately, so it is a field on the same frozen object.
 *
 * A summary is `undefined` when nothing was recorded, never a zero-filled object: every field here
 * is a plain `number`, so a threshold predicate reads `s.p99 < 250` without an `?? 0` that would
 * let a scenario which never ran pass its own threshold.
 */

export interface HistogramSummary {
  readonly count: number;
  /** Microseconds. Bucket-top values: at or above the truth by <0.1 %, unless `isLowerBound`. */
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly p999: number;
  readonly overflowCount: number;
  readonly saturated: boolean;
  /** `overflowCount > 0` — the upper tail was clamped, so these numbers understate the truth. */
  readonly isLowerBound: boolean;
}

/** The same projection in milliseconds, for `Trend`. Every field carries its unit. */
export interface TrendSummary {
  readonly count: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly p999Ms: number;
  readonly overflowCount: number;
  readonly saturated: boolean;
  readonly isLowerBound: boolean;
}

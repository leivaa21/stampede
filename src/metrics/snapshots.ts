/**
 * The metrics wire format — everything that crosses the worker boundary, in one file.
 *
 * All of it is structured-cloneable: maps, strings, numbers, booleans and typed arrays, no class
 * instances (D1-03). Anything arriving from a port is untrusted until it has been through
 * `parseRegistrySnapshot`; these types describe what comes out the other side, never what went in.
 */

export interface HistogramSnapshot {
  readonly counts: Int32Array;
  /** Samples that exceeded the layout ceiling. Included in the bucket counts, clamped to the top. */
  readonly overflowCount: number;
  /** Latches once a bucket hit its Int32 ceiling and samples started being dropped. */
  readonly saturated: boolean;
}

export interface CheckTally {
  readonly passed: number;
  readonly failed: number;
}

/**
 * Recordings refused because a metric name broke the cardinality or length cap. Counted, never
 * silently dropped — an unreported refusal is a hole in the numbers (see `validate.ts`).
 */
export interface CountersSnapshot {
  readonly totals: ReadonlyMap<string, number>;
  readonly refusedCount: number;
}

export interface ChecksSnapshot {
  readonly tallies: ReadonlyMap<string, CheckTally>;
  readonly refusedCount: number;
}

/**
 * Histograms (µs) and trends (ms) occupy separate namespaces rather than one map: sharing a name
 * space would let a worker's `behindMs` trend merge into a latency histogram, and the resulting
 * number would look perfectly plausible.
 */
export interface ScenarioSnapshot {
  readonly histograms: ReadonlyMap<string, HistogramSnapshot>;
  readonly trends: ReadonlyMap<string, HistogramSnapshot>;
  readonly counters: CountersSnapshot;
  readonly checks: ChecksSnapshot;
  /** Histogram and trend recordings refused by the cardinality cap. */
  readonly refusedCount: number;
}

export interface RegistrySnapshot {
  /**
   * Worker-assigned, strictly increasing across the snapshots one worker posts.
   *
   * Snapshots are cumulative, so the aggregate is "keep the newest per worker". Without a sequence
   * that reduces to "keep the last one that arrived", which is only correct while every snapshot
   * travels the same ordered port — a constraint the worker pool has not made yet, and one an exit
   * handler or a second MessageChannel would quietly break. The number makes the ordering explicit
   * instead of inherited (D1-03).
   *
   * Two obligations this puts on the worker pool, spelled out because the aggregator cannot infer
   * either one:
   *
   * 1. **A worker's final snapshot must carry a fresh sequence**, even when nothing was recorded
   *    since its last tick. Re-posting the previous number is indistinguishable from a duplicate,
   *    so the final snapshot would be ignored as superseded — harmless for the totals, since it
   *    carries identical data, but it inflates `supersededCount` and thereby blurs the one signal
   *    that distinguishes expected duplicates from genuine reordering.
   * 2. **A worker id is never retired.** A worker that crashes and is respawned must reuse its id
   *    and continue the sequence, or its cumulative totals stay in the aggregate forever under the
   *    old id while the replacement double-counts them under a new one. If a future pool wants
   *    replacement semantics, that is a protocol change, not a detail the aggregator can guess.
   */
  readonly sequence: number;
  readonly scenarios: ReadonlyMap<string, ScenarioSnapshot>;
}

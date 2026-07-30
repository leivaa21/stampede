/**
 * The metrics core: every number stampede publishes comes out of here.
 *
 * Pure by rule — no I/O, no timers, no `Date.now()`. The caller supplies the samples; this module
 * only counts and merges them. `histogram-layout.ts` carries the bucket arithmetic,
 * `snapshots.ts` the wire format, and `snapshot-aggregator.ts` the worker-merge protocol.
 */

export { Checks } from "./checks.ts";
export { Counters } from "./counters.ts";
export { Histogram } from "./histogram.ts";
export { MAX_TRACKABLE_US } from "./histogram-layout.ts";
export { SnapshotFormatError } from "./narrow.ts";
export { MetricsRegistry } from "./registry.ts";
export { ScenarioMetrics } from "./scenario-metrics.ts";
export { SnapshotAggregator } from "./snapshot-aggregator.ts";
export { parseRegistrySnapshot } from "./snapshot-parse.ts";
export type {
  ChecksSnapshot,
  CheckTally,
  CountersSnapshot,
  HistogramSnapshot,
  RegistrySnapshot,
  ScenarioSnapshot,
} from "./snapshots.ts";
export type { HistogramSummary, TrendSummary } from "./summaries.ts";
export { MAX_TRACKABLE_MS, Trend } from "./trend.ts";
// Exported so a consumer that finds `refusedCount > 0` can discover which limit refused it.
export {
  MAX_DISTINCT_DISTRIBUTIONS,
  MAX_DISTINCT_SCENARIOS,
  MAX_DISTINCT_TALLIES,
  MAX_METRIC_NAME_LENGTH,
} from "./validate.ts";

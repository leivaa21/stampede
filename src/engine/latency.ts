import type { ScenarioMetrics } from "../metrics/index.ts";
import { EngineMetric } from "./metric-names.ts";

/**
 * The two numbers D1-01 exists for, and the arithmetic that turns clock readings into samples.
 *
 * `latency` is what the target took. `scheduledLatency` starts the stopwatch at the instant the
 * request was **scheduled** for, so any time the generator itself spent backed up sits inside the
 * number a user waiting in line would have experienced. While the generator keeps up the two are
 * identical; when it does not, the gap is the story — and anyone "fixing" this to measure only
 * from the send is reintroducing coordinated omission.
 */

const MICROSECONDS_PER_MS = 1000;
const NANOSECONDS_PER_US = 1000;

/**
 * A duration in µs, for the histograms.
 *
 * Rounded at nanosecond scale first — far below the instrument's own resolution — because
 * `ms * 1000` is not exact in binary floating point (`2.007` becomes `2007.0000000000002`) and the
 * histogram rounds fractions up, so that noise would cost a whole spurious microsecond on every
 * sample unlucky enough to land on it.
 *
 * Clamped at zero as a backstop: the clock port promises monotonicity, but a clock that breaks
 * that promise should not be able to abort a twenty-minute run with a `RangeError` out of
 * `Histogram.record`.
 */
export const microsecondsBetween = (startMs: number, endMs: number): number =>
  Math.max(
    0,
    Math.round((endMs - startMs) * MICROSECONDS_PER_MS * NANOSECONDS_PER_US) / NANOSECONDS_PER_US,
  );

export interface ResponseTiming {
  /** When the request was *supposed* to go out. */
  readonly scheduledAtMs: number;
  /** When it actually did. */
  readonly sentAtMs: number;
  readonly doneAtMs: number;
}

/** Records both distributions for one response, from one clock reading. */
export const recordLatencies = (metrics: ScenarioMetrics, timing: ResponseTiming): void => {
  metrics
    .histogram(EngineMetric.latency)
    .record(microsecondsBetween(timing.sentAtMs, timing.doneAtMs));
  metrics
    .histogram(EngineMetric.scheduledLatency)
    .record(microsecondsBetween(timing.scheduledAtMs, timing.doneAtMs));
};

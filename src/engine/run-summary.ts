import type { HistogramSummary, MetricsRegistry, TrendSummary } from "../metrics/index.ts";
import { EngineMetric } from "./metric-names.ts";

/**
 * What the run has to admit to when it is over.
 *
 * The rule this shape exists to enforce is D1-01's: a load generator that cannot keep up must say
 * so, on the same page as its percentiles. So requested and achieved rate sit side by side, drops
 * and abandoned requests are fields rather than log lines, and every number is read back out of
 * the metrics registry the dispatcher recorded into — the summary is a projection, not a second
 * set of books that could disagree with the first.
 *
 * Frozen and read-only, like `metrics/`'s summaries, and for the same reason: it is handed to a
 * reporter and to threshold predicates, and neither should be able to edit the record.
 */

const MS_PER_SECOND = 1000;
const MICROSECONDS_PER_MS = 1000;

/**
 * A latency distribution in milliseconds.
 *
 * Structurally identical to `TrendSummary` — same projection, same units — so it is an alias rather
 * than a parallel shape that could drift out of step with it.
 */
export type LatencySummary = TrendSummary;

/**
 * Microseconds are the histogram's *storage precision*, not a unit anyone writes a threshold in.
 *
 * Leaving raw µs on this surface put two units side by side with no unit in either name, and D1-06's
 * own worked example — `s.scenarios.reads.p99 < 250` — would then have been a thousand times too
 * lenient while type-checking perfectly. `arrival-profiles.ts` already states the repo rule that a
 * field name carries its unit; this is that rule applied to the surface a reporter and a threshold
 * predicate actually read.
 *
 * Converted, never rounded: full float precision belongs in the data, and presentation belongs to
 * the renderer.
 */
const toLatencySummary = (summary: HistogramSummary | undefined): LatencySummary | undefined =>
  summary === undefined
    ? undefined
    : Object.freeze({
        count: summary.count,
        minMs: summary.min / MICROSECONDS_PER_MS,
        maxMs: summary.max / MICROSECONDS_PER_MS,
        meanMs: summary.mean / MICROSECONDS_PER_MS,
        p50Ms: summary.p50 / MICROSECONDS_PER_MS,
        p95Ms: summary.p95 / MICROSECONDS_PER_MS,
        p99Ms: summary.p99 / MICROSECONDS_PER_MS,
        p999Ms: summary.p999 / MICROSECONDS_PER_MS,
        overflowCount: summary.overflowCount,
        saturated: summary.saturated,
        isLowerBound: summary.isLowerBound,
      });

export interface ScenarioRunSummary {
  readonly name: string;
  /** Dispatch instants the profile asked for, known before the run started. */
  readonly scheduledCount: number;
  /** Requests actually handed to the transport. */
  readonly dispatchedCount: number;
  /** Requests refused by the in-flight cap: dropped, and counted here so a report can annotate it. */
  readonly droppedCount: number;
  readonly responseCount: number;
  /** Transport-level failures. Counted, and deliberately absent from the latency percentiles. */
  readonly errorCount: number;
  /** Requests still outstanding when the run stopped waiting. Never timed, never guessed at. */
  readonly abandonedCount: number;
  /**
   * The rate the profile asked for, averaged over its own span. `undefined` for an instantaneous
   * burst: a burst asks for a *count*, and "500 requests in 0.4 ms = 1.25 M rps" is arithmetic
   * rather than information.
   */
  readonly requestedRatePerSecond: number | undefined;
  /**
   * Dispatches per second over the longer of the profile's span and the time the run really took
   * to issue them — so a generator that fell behind divides by the time it actually spent, not by
   * the time it was supposed to spend. `undefined` wherever `requestedRatePerSecond` is.
   *
   * Full precision, deliberately unrounded. This is the machine-readable surface threshold
   * predicates read (`achieved >= requested * 0.95`); rounding it here would bake a presentation
   * policy into the data. The renderer is where `1880.836698138292` becomes `1881`.
   */
  readonly achievedRatePerSecond: number | undefined;
  /** Send → response: what the target took. `undefined` if nothing was recorded — never a zero. */
  readonly latencyMs: LatencySummary | undefined;
  /** Scheduled instant → response. The headline distribution (D1-01). */
  readonly scheduledLatencyMs: LatencySummary | undefined;
  /** Scheduled instant → send. The generator's own backlog. */
  readonly scheduleLagMs: TrendSummary | undefined;
}

export interface RunSummary {
  /** Wall-clock span of the whole run, dispatch through drain. */
  readonly elapsedMs: number;
  readonly scenarios: readonly ScenarioRunSummary[];
  readonly droppedCount: number;
  readonly abandonedCount: number;
  /**
   * The high-water mark of concurrent outstanding requests. Reported because it is the distance
   * between a run that stayed comfortably under `maxInFlight` and one that spent the whole time
   * pressed against it, which the drop count alone cannot tell apart.
   */
  readonly maxObservedInFlight: number;
}

/** Per-scenario facts only the dispatcher saw — everything else is read back out of the metrics. */
export interface ScenarioProgress {
  readonly name: string;
  readonly scheduledCount: number;
  readonly requestedDurationMs: number;
  /** Elapsed ms at the last dispatch, or `undefined` if the scenario never dispatched anything. */
  readonly lastDispatchElapsedMs: number | undefined;
}

export interface RunProgress {
  readonly elapsedMs: number;
  readonly maxObservedInFlight: number;
  readonly scenarios: readonly ScenarioProgress[];
}

const ratePerSecond = (count: number, spanMs: number): number | undefined =>
  spanMs <= 0 ? undefined : (count * MS_PER_SECOND) / spanMs;

const summariseScenario = (
  progress: ScenarioProgress,
  metrics: MetricsRegistry,
): ScenarioRunSummary => {
  // `findScenario`, not `scenario`: a read must never conjure the thing it asked for, or a summary
  // of a scenario that never ran renders as a real section full of zeroes. Through `runDispatch`
  // this is belt-and-braces — the dispatcher pre-creates every namespace, so the name is always
  // there — but `summariseRun` is exported and PR 6 consumes it directly.
  const recorded = metrics.findScenario(progress.name);
  const counted = (name: string): number => recorded?.counters.get(name) ?? 0;

  const dispatchedCount = counted(EngineMetric.dispatched);
  const requestedRatePerSecond = ratePerSecond(
    progress.scheduledCount,
    progress.requestedDurationMs,
  );

  return Object.freeze({
    name: progress.name,
    scheduledCount: progress.scheduledCount,
    dispatchedCount,
    droppedCount: counted(EngineMetric.dropped),
    responseCount: counted(EngineMetric.responses),
    errorCount: counted(EngineMetric.errors),
    abandonedCount: counted(EngineMetric.abandoned),
    requestedRatePerSecond,
    achievedRatePerSecond:
      requestedRatePerSecond === undefined
        ? undefined
        : ratePerSecond(
            dispatchedCount,
            Math.max(progress.requestedDurationMs, progress.lastDispatchElapsedMs ?? 0),
          ),
    latencyMs: toLatencySummary(recorded?.findHistogram(EngineMetric.latency)?.summary()),
    scheduledLatencyMs: toLatencySummary(
      recorded?.findHistogram(EngineMetric.scheduledLatency)?.summary(),
    ),
    scheduleLagMs: recorded?.findTrend(EngineMetric.scheduleLag)?.summaryMs(),
  });
};

export const summariseRun = (progress: RunProgress, metrics: MetricsRegistry): RunSummary => {
  const scenarios = progress.scenarios.map((scenario) => summariseScenario(scenario, metrics));
  const total = (pick: (scenario: ScenarioRunSummary) => number): number =>
    scenarios.reduce((sum, scenario) => sum + pick(scenario), 0);

  return Object.freeze({
    elapsedMs: progress.elapsedMs,
    scenarios: Object.freeze(scenarios),
    droppedCount: total((scenario) => scenario.droppedCount),
    abandonedCount: total((scenario) => scenario.abandonedCount),
    maxObservedInFlight: progress.maxObservedInFlight,
  });
};

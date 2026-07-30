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
   */
  readonly achievedRatePerSecond: number | undefined;
  /** µs, send → response. `undefined` when nothing was recorded — never a flattering zero. */
  readonly latency: HistogramSummary | undefined;
  /** µs, scheduled instant → response. The headline distribution (D1-01). */
  readonly scheduledLatency: HistogramSummary | undefined;
  /** ms, scheduled instant → send. The generator's own backlog. */
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
  // `findScenario`, not `scenario`: a read must never conjure the thing it asked for, or a
  // summary of a scenario that never ran renders as a real section full of zeroes.
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
    latency: recorded?.findHistogram(EngineMetric.latency)?.summary(),
    scheduledLatency: recorded?.findHistogram(EngineMetric.scheduledLatency)?.summary(),
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

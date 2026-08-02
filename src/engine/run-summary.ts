import type {
  HistogramSummary,
  MetricsRegistry,
  ScenarioMetrics,
  TrendSummary,
} from "../metrics/index.ts";
import { brokenCheckCounter, EngineMetric, RESERVED_METRIC_PREFIX } from "./metric-names.ts";

const BROKEN_CHECK_PREFIX = `${RESERVED_METRIC_PREFIX}brokenCheck.`;

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
  /**
   * Requests the scenario's own builder could not produce, so they were never sent.
   *
   * A named field rather than a counter buried in the map, because without it
   * `dispatched + dropped === scheduled` — the identity the README claims — silently stopped
   * holding, and a halved achieved rate had no cause anywhere on the page.
   */
  readonly requestErrorCount: number;
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
  /**
   * The scenario's own counters, by name — whatever `onResponse` incremented.
   *
   * Per scenario and only per scenario (D2-03). A merged top-level view would mean a
   * `reserved201` in the write scenario and one in the read scenario silently adding together,
   * which is the class of quiet wrongness this repo refuses everywhere else.
   */
  readonly counters: Readonly<Record<string, number>>;
  /**
   * The scenario's checks, by name — three states, not two.
   *
   * `broken` counts responses where the predicate threw or returned a non-boolean. It is separate
   * from `failed` because writing a throw into `failed` made the checks table read
   * "**FAIL** | oneWinnerOrConflict | 0 | 500" — a report accusing the target of double-selling
   * 500 seats because a predicate had a typo (D2-04).
   */
  readonly checks: Readonly<
    Record<string, { readonly passed: number; readonly failed: number; readonly broken: number }>
  >;
  /** Distributions `onResponse` recorded — contract run 4's `behindMs` lands here. */
  readonly trends: Readonly<Record<string, TrendSummary>>;
  /**
   * Checks whose predicate threw or returned a non-boolean, plus `onResponse` callbacks that threw.
   *
   * Non-zero means an *assertion* is broken, not that the target is — so the run fails, but with
   * the check named rather than the system blamed (D2-04).
   */
  readonly brokenObservations: number;
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

/**
 * The engine records its own metrics into the same namespace the user does, prefixed `stampede.`.
 *
 * Projecting them into a threshold-facing summary would put `s.counters["stampede.dropped"]` next
 * to the user's own names — a surface where a rename inside the engine silently changes what a
 * user's threshold reads. Engine metrics have named fields on the summary already; the user's keep
 * the map.
 */
const isUserMetric = (name: string): boolean => !name.startsWith(RESERVED_METRIC_PREFIX);

const userCounters = (recorded: ScenarioMetrics | undefined): Readonly<Record<string, number>> =>
  Object.freeze(
    Object.fromEntries(
      [...(recorded?.counters.names ?? [])]
        .filter(isUserMetric)
        .map((name) => [name, recorded?.counters.get(name) ?? 0]),
    ),
  );

/**
 * Every check the scenario recorded *or* broke.
 *
 * A check that threw on every single response has no pass/fail tally at all — it only has a broken
 * count — so reading `checks.names` alone would omit the very check a reader most needs named.
 */
const userChecks = (
  recorded: ScenarioMetrics | undefined,
): Readonly<
  Record<string, { readonly passed: number; readonly failed: number; readonly broken: number }>
> => {
  const names = new Set<string>(recorded?.checks.names ?? []);
  for (const counter of recorded?.counters.names ?? []) {
    if (counter.startsWith(BROKEN_CHECK_PREFIX)) {
      names.add(counter.slice(BROKEN_CHECK_PREFIX.length));
    }
  }
  return Object.freeze(
    Object.fromEntries(
      [...names].sort().map((name) => [
        name,
        Object.freeze({
          ...(recorded?.checks.get(name) ?? { passed: 0, failed: 0 }),
          broken: recorded?.counters.get(brokenCheckCounter(name)) ?? 0,
        }),
      ]),
    ),
  );
};

const userTrends = (
  recorded: ScenarioMetrics | undefined,
): Readonly<Record<string, TrendSummary>> => {
  const entries: [string, TrendSummary][] = [];
  for (const name of recorded?.trendNames ?? []) {
    const summary = isUserMetric(name) ? recorded?.findTrend(name)?.summaryMs() : undefined;
    if (summary !== undefined) {
      entries.push([name, summary]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
};

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
    requestErrorCount: counted(EngineMetric.requestErrors),
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
    counters: userCounters(recorded),
    checks: userChecks(recorded),
    trends: userTrends(recorded),
    brokenObservations:
      (recorded?.counters.get(EngineMetric.brokenChecks) ?? 0) +
      (recorded?.counters.get(EngineMetric.brokenObservers) ?? 0) +
      (recorded?.counters.get(EngineMetric.reservedNameRefusals) ?? 0),
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

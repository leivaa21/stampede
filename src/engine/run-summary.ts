import type {
  HistogramSummary,
  MetricsRegistry,
  ScenarioMetrics,
  TrendSummary,
} from "../metrics/index.ts";
import { compareNames } from "../metrics/by-name.ts";
import {
  brokenCheckCounter,
  EngineMetric,
  keyedCounter,
  OTHER_KEY,
  RESERVED_METRIC_PREFIX,
} from "./metric-names.ts";

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
   * Requests whose builder mutated the frozen setup state (D25-02).
   *
   * Its own field rather than folded into `requestErrorCount`, because the consequence differs: a
   * builder that threw produced no request, while one that mutated shared state is silently wrong
   * across threads. Folded together it read as "7 not built" and the run exited 0.
   */
  readonly impureRequestCount: number;
  /**
   * Requests the scenario's own builder could not produce, so they were never sent.
   *
   * A named field rather than a counter buried in the map, because without it
   * `dispatched + dropped === scheduled` — the identity the README claims — silently stopped
   * holding, and a halved achieved rate had no cause anywhere on the page. `impureRequestCount`
   * is part of the same identity, for the same reason.
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
  /**
   * Counters whose key space the scenario declared, nested by counter name (D25-01).
   *
   * Stored flat (`byStatus.5xx`) so the merge stays the exact elementwise addition it always was,
   * and projected back into the shape the config declared so a threshold reads
   * `keyedCounters.byStatus["5xx"]` rather than a stringly-joined key. Every declared key is
   * present — including `other` — because the slots were reserved before the run, so a key that
   * never fired reads `0` rather than being absent.
   */
  readonly keyedCounters: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Distributions `onResponse` recorded — contract run 4's `behindMs` lands here. */
  readonly trends: Readonly<Record<string, TrendSummary>>;
  /**
   * Checks whose predicate threw or returned a non-boolean, plus `onResponse` callbacks that threw.
   *
   * Non-zero means an *assertion* is broken, not that the target is — so the run fails, but with
   * the check named rather than the system blamed (D2-04).
   */
  readonly brokenObservations: number;
  /**
   * Recordings the metrics registry refused for cardinality — names asked for beyond the caps.
   *
   * `metrics/validate.ts` states the rule this field exists to keep: *a refusal nobody counts is a
   * silent hole in the numbers*. The count existed and nothing published it, so a config asking for
   * 600 counter names got 512 and a threshold reading one of the missing ones read a confident 0 —
   * a violation the target never caused, in a run that looked complete.
   */
  readonly refusedRecordings: number;
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
  /**
   * The key spaces this scenario declared, so the summary can project flat storage back into them.
   *
   * Carried on progress rather than read from the config because `summariseRun` runs on the *main
   * thread over merged inputs* and never sees the config — and plain arrays of strings cross the
   * worker boundary by structured clone without any special handling.
   */
  readonly keyedCounters: Readonly<Record<string, readonly string[]>>;
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

/**
 * The scenario's plain counters — everything the engine did not reserve, and nothing keyed.
 *
 * Keyed slots are excluded rather than left in as `byStatus.5xx`: they are reported nested by
 * `keyedCountersOf` below, and listing them twice would let a reader add the same number into two
 * totals. Excluded *by declaration*, not by looking for a dot — a plain counter is allowed to have
 * one in its name.
 */
const userCounters = (
  recorded: ScenarioMetrics | undefined,
  declared: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, number>> => {
  const keyed = new Set(
    Object.entries(declared).flatMap(([name, keys]) =>
      [...keys, OTHER_KEY].map((key) => keyedCounter(name, key)),
    ),
  );
  return Object.freeze(
    Object.fromEntries(
      [...(recorded?.counters.names ?? [])]
        .filter((name) => isUserMetric(name) && !keyed.has(name))
        .map((name) => [name, recorded?.counters.get(name) ?? 0]),
    ),
  );
};

/**
 * Declared keyed counters, projected back into the shape the config wrote.
 *
 * Driven by the *declaration*, not by what was recorded, so every declared key is present at `0`
 * rather than absent — the same reason `metrics/` publishes a reserved counter that never fired.
 * A threshold reading `byStatus["5xx"] === 0` should mean "none happened", not "the key is missing".
 */
const keyedCountersOf = (
  recorded: ScenarioMetrics | undefined,
  declared: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, Readonly<Record<string, number>>>> =>
  Object.freeze(
    Object.fromEntries(
      // Sorted, like every other name-keyed map on this summary. Declaration order would also be
      // deterministic, but it would read differently from the maps printed beside it.
      Object.entries(declared)
        .sort(([a], [b]) => compareNames(a, b))
        .map(([name, keys]) => [
          name,
          Object.freeze(
            Object.fromEntries(
              [...keys, OTHER_KEY].map((key) => [
                key,
                recorded?.counters.get(keyedCounter(name, key)) ?? 0,
              ]),
            ),
          ),
        ]),
    ),
  );

/**
 * Every check the scenario actually observed — recorded, failed *or* broke.
 *
 * Two names have to be reachable here. A check that threw on every single response has no pass/fail
 * tally at all, only a broken count, so reading `checks.names` alone would omit the very check a
 * reader most needs named. And the broken counters are *reserved* before the run starts, so reading
 * the counter map alone would list every declared check whether or not it ever ran.
 *
 * Hence the emptiness test: a check with nothing in any of its three states was never asked, and
 * publishing it as `{ passed: 0, failed: 0, broken: 0 }` would render as **PASS** — a green claim
 * about responses that do not exist, which is the one thing this file exists to prevent.
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
  const observed = [...names]
    .sort(compareNames)
    .map((name): [string, { passed: number; failed: number; broken: number }] => [
      name,
      {
        ...(recorded?.checks.get(name) ?? { passed: 0, failed: 0 }),
        broken: recorded?.counters.get(brokenCheckCounter(name)) ?? 0,
      },
    ])
    .filter(([, tally]) => tally.passed + tally.failed + tally.broken > 0);

  return Object.freeze(
    Object.fromEntries(observed.map(([name, tally]) => [name, Object.freeze(tally)])),
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
    impureRequestCount: counted(EngineMetric.impureRequests),
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
    counters: userCounters(recorded, progress.keyedCounters),
    keyedCounters: keyedCountersOf(recorded, progress.keyedCounters),
    checks: userChecks(recorded),
    trends: userTrends(recorded),
    refusedRecordings: recorded?.refusedCount ?? 0,
    brokenObservations:
      (recorded?.counters.get(EngineMetric.brokenChecks) ?? 0) +
      (recorded?.counters.get(EngineMetric.brokenObservers) ?? 0) +
      (recorded?.counters.get(EngineMetric.reservedNameRefusals) ?? 0) +
      // A `countKeyed` naming a counter the config never declared is a claim stampede refused, and
      // the refusal has to reach the verdict or it is the silent hole the counter's own docblock
      // says it exists to prevent. Found by running it: the run exited 0 having discarded every
      // increment for an undeclared counter.
      (recorded?.counters.get(EngineMetric.undeclaredCounters) ?? 0) +
      // A plain `count` that landed on a declared slot: refused, and the run has to say so or the
      // increments vanish silently — the same silent hole, one door over.
      (recorded?.counters.get(EngineMetric.collidingCounters) ?? 0) +
      // A builder that mutated the state is a broken *claim* about the run, not a broken target —
      // and it has to fail the run, or the tool drops most of its own load and reports success.
      (recorded?.counters.get(EngineMetric.impureRequests) ?? 0),
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

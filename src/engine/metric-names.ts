/**
 * The metric names the engine records under, in one place and prefixed.
 *
 * A scenario's own `counters.inc("errors")` shares a namespace with the engine's bookkeeping, and
 * a silent collision would corrupt exactly the kind of published number this repo keeps refusing
 * to get wrong. The prefix makes the engine's names impossible to hit by accident, and exporting
 * them means the reporter and the thresholds look them up by constant instead of by a string
 * literal they can mistype into a phantom metric.
 *
 * They are ordinary counters, histograms and trends rather than fields on some side channel
 * because everything here has to survive the worker → main-thread merge, and the metrics registry
 * is the one carrier that merges exactly, associatively and commutatively (D1-03).
 */
/**
 * The engine's own metric namespace.
 *
 * Reserved rather than merely conventional: the engine and the user write into the same maps, so a
 * user counter named `stampede.dropped` would rewrite a published engine number. Refused at the
 * recording edge, and rejected for check names at config load.
 */
export const RESERVED_METRIC_PREFIX = "stampede.";

/** Per-check broken tally, so a report can name *which* claim is broken rather than only how many. */
export const brokenCheckCounter = (checkName: string): string =>
  `${RESERVED_METRIC_PREFIX}brokenCheck.${checkName}`;

/**
 * The bucket an undeclared key lands in. Implicit and always reserved.
 *
 * A key that was not declared has to go *somewhere* — dropping it would be the silent hole
 * `metrics/validate.ts` refuses. Implicit means a config cannot forget it, and a non-zero `other`
 * is itself the signal that the declared key space is wrong.
 */
export const OTHER_KEY = "other";

/**
 * Where a keyed counter's key is stored: `byStatus.5xx`, in the user's own namespace.
 *
 * Flat storage, nested projection. The counter map, its cap and its exact elementwise merge are
 * unchanged — a keyed counter is a *reservation pattern*, not a new metric kind, which is what lets
 * D1-02's order-independence hold for it without being re-argued.
 */
export const keyedCounter = (name: string, key: string): string => `${name}.${key}`;

export const EngineMetric = {
  /** Histogram, µs: actual send → response. What the target took. */
  latency: "stampede.latency",
  /**
   * Histogram, µs: **scheduled instant** → response. What a user waiting in line experienced,
   * generator backlog included. The headline percentile of the whole tool (D1-01).
   */
  scheduledLatency: "stampede.scheduledLatency",
  /**
   * Trend, ms: scheduled instant → actual send. The generator's own backlog on its own terms.
   *
   * Redundant with the gap between the two histograms above, on purpose: that gap is a difference
   * of percentiles, which is not a percentile of the difference. A run where the p99 lag lands on
   * a few requests reads very differently from one where every request was 40 ms late, and only a
   * distribution of the lag itself can tell those apart.
   */
  scheduleLag: "stampede.scheduleLagMs",
  /** Counter: requests actually handed to the transport. */
  dispatched: "stampede.dispatched",
  /** Counter: requests refused by the in-flight cap. Dropped and counted, never absorbed. */
  dropped: "stampede.dropped",
  /** Counter: responses received and timed. */
  responses: "stampede.responses",
  /** Counter: transport-level failures — connection refused, DNS, timeout. Not timed. */
  errors: "stampede.errors",
  /** Counter: requests still outstanding when the run stopped waiting. */
  abandoned: "stampede.abandoned",
  /**
   * Checks whose predicate threw, or returned something that is not a boolean.
   *
   * Counted rather than recorded individually: a check that throws on every response would fill a
   * run with a run's worth of identical strings, and what a reader needs is the check's *name* and
   * the fact that it is broken — not five thousand copies of the same stack.
   */
  brokenChecks: "stampede.brokenChecks",
  /** `onResponse` callbacks that threw. Same reasoning as `brokenChecks`. */
  brokenObservers: "stampede.brokenObservers",
  /**
   * Requests the scenario's own builder could not produce.
   *
   * Counted apart from transport errors on purpose: "your `request()` threw at ordinal 4,001" and
   * "the target refused the connection" are different problems with different owners, and folding
   * them together would send someone to debug a network that was fine.
   */
  requestErrors: "stampede.requestErrors",
  /**
   * Counter increments and recordings refused for using the engine's reserved prefix.
   *
   * Refused rather than accepted, because accepting would let a user's counter rewrite a published
   * engine number; counted rather than dropped, because a refusal nobody counts is a silent hole.
   */
  reservedNameRefusals: "stampede.reservedNameRefusals",
  /**
   * `countKeyed` calls naming a counter the scenario never declared.
   *
   * Refused rather than accepted, because there is no bounded slot to put it in and inventing one
   * is the cardinality bomb declared keys exist to prevent; counted rather than dropped, because a
   * refusal nobody counts is a silent hole.
   */
  undeclaredCounters: "stampede.undeclaredCounters",
  /**
   * `count` calls whose name lands on a slot a declared key space owns.
   *
   * Refused rather than accepted: writing into `byStatus.5xx` from a plain `count` publishes
   * responses the target never sent, under a key a threshold reads — so the target gets blamed for
   * a naming collision. Counted, because a refusal nobody counts is a silent hole.
   */
  collidingCounters: "stampede.collidingCounters",
} as const;

/**
 * Which kind of metric each name is recorded as.
 *
 * Exhaustive over `EngineMetric` by type, so adding a member without classifying it is a compile
 * error. That is the point: `ENGINE_COUNTERS` below is derived from this map, and a counter left
 * out of it is silently starvable again — a regression no test would notice, because the failure
 * only appears in a run whose user code fills the name budget first.
 */
const ENGINE_METRIC_KINDS: Readonly<Record<keyof typeof EngineMetric, "counter" | "distribution">> =
  {
    latency: "distribution",
    scheduledLatency: "distribution",
    scheduleLag: "distribution",
    dispatched: "counter",
    dropped: "counter",
    responses: "counter",
    errors: "counter",
    abandoned: "counter",
    brokenChecks: "counter",
    brokenObservers: "counter",
    requestErrors: "counter",
    reservedNameRefusals: "counter",
    undeclaredCounters: "counter",
    collidingCounters: "counter",
  };

/**
 * The engine's counter names, for pre-registration before any load goes out.
 *
 * The prefix stops a user counter *overwriting* an engine one. It does not stop a user counter
 * *starving* it: names are admitted while the map is under its cardinality cap, and every engine
 * counter is created lazily on its first increment — so an `onResponse` doing
 * `record.count(\`seat-\${seatId}\`)`, which is contract run 2's own shape, fills the map and then
 * every engine counter that has not yet fired is refused.
 *
 * The counters that starve are exactly the ones that matter: `dropped` and `abandoned` are first
 * incremented when the target falls over, which is *after* a run's worth of user names exist. A
 * run that dropped 350 requests then reports zero drops, and `dispatched + dropped + notBuilt ===
 * scheduled` — the identity the README claims — stops holding with nothing on the page to say so.
 *
 * Reserving a slot each makes `known.has(name)` permanently true, which is the only thing the
 * cardinality rule looks at. The count is deliberately not written here: hardcoding it made a test
 * the thing that broke when a metric was added, and prose rots the same way.
 *
 * No count of which names are pinned by tests lives here. The last one was wrong in both
 * directions — it named two as unpinnable that were pinned, and omitted the two most starvable of
 * all — and a tally in prose is exactly what rots. What matters is the rule: every counter on this
 * list is reserved, whether or not a test currently proves that particular one matters, because
 * "which engine counters happen to fire first" changes the moment the dispatch loop is reordered.
 */
export const ENGINE_COUNTERS: readonly string[] = Object.keys(ENGINE_METRIC_KINDS)
  .filter(
    (key): key is keyof typeof EngineMetric =>
      ENGINE_METRIC_KINDS[key as keyof typeof EngineMetric] === "counter",
  )
  .map((key) => EngineMetric[key]);

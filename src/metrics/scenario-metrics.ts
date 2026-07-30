import { compareNames, mapByName, mergeByName } from "./by-name.ts";
import { Checks } from "./checks.ts";
import { Counters } from "./counters.ts";
import { Histogram } from "./histogram.ts";
import type { ScenarioSnapshot } from "./snapshots.ts";
import { Trend } from "./trend.ts";
import { admitsMetricName, assertMetricName, MAX_DISTINCT_DISTRIBUTIONS } from "./validate.ts";

/**
 * The metrics of a single scenario. A run holds several of these side by side, because read p99
 * averaged with write p99 destroys the exact asymmetry run 3 exists to measure (D1-05).
 *
 * **Recording and reading are separate surfaces on purpose.** `histogram(name)` and `trend(name)`
 * create on first use, which is what a virtual user wants; `findHistogram`/`findTrend` never do.
 * A reporter or a threshold predicate that reaches for a mistyped name must get `undefined` back,
 * not conjure an empty metric that then renders as a real section of the report.
 */
export class ScenarioMetrics {
  readonly #histograms = new Map<string, Histogram>();
  readonly #trends = new Map<string, Trend>();
  #counters = new Counters();
  #checks = new Checks();
  #refusedCount = 0;
  /** Bit buckets for refused names — created only if the cap is ever hit, never snapshotted. */
  #histogramSink: Histogram | undefined;
  #trendSink: Trend | undefined;

  static fromSnapshot(snapshot: ScenarioSnapshot): ScenarioMetrics {
    const restored = ScenarioMetrics.#of(
      mapByName(snapshot.histograms, (histogram) => Histogram.fromSnapshot(histogram)),
      mapByName(snapshot.trends, (trend) => Trend.fromSnapshot(trend)),
      Counters.fromSnapshot(snapshot.counters),
      Checks.fromSnapshot(snapshot.checks),
    );
    restored.#refusedCount = snapshot.refusedCount;
    return restored;
  }

  /**
   * Get-or-create — recording is the only thing that brings a metric into existence.
   *
   * Past the cardinality cap the recording is refused and counted, and the caller gets a **single
   * shared sink** rather than a fresh metric: allocating one 68 KiB histogram per refused name is
   * the very cost the cap exists to prevent. Nothing written to the sink is ever snapshotted, so
   * the count of refusals is the only trace it leaves — which is the point (see `validate.ts`).
   */
  histogram(name: string): Histogram {
    assertMetricName(name, "histogram");
    const existing = this.#histograms.get(name);
    if (existing !== undefined) {
      return existing;
    }
    if (!admitsMetricName(this.#histograms, name, MAX_DISTINCT_DISTRIBUTIONS)) {
      this.#refusedCount += 1;
      this.#histogramSink ??= new Histogram();
      return this.#histogramSink;
    }
    const created = new Histogram();
    this.#histograms.set(name, created);
    return created;
  }

  /** Get-or-create, in milliseconds. See `Trend` for why the unit is in every member name. */
  trend(name: string): Trend {
    assertMetricName(name, "trend");
    const existing = this.#trends.get(name);
    if (existing !== undefined) {
      return existing;
    }
    if (!admitsMetricName(this.#trends, name, MAX_DISTINCT_DISTRIBUTIONS)) {
      this.#refusedCount += 1;
      this.#trendSink ??= new Trend();
      return this.#trendSink;
    }
    const created = new Trend();
    this.#trends.set(name, created);
    return created;
  }

  /** Non-mutating lookup — `undefined` for a metric that was never recorded. */
  findHistogram(name: string): Histogram | undefined {
    return this.#histograms.get(name);
  }

  findTrend(name: string): Trend | undefined {
    return this.#trends.get(name);
  }

  hasHistogram(name: string): boolean {
    return this.#histograms.has(name);
  }

  hasTrend(name: string): boolean {
    return this.#trends.has(name);
  }

  get counters(): Counters {
    return this.#counters;
  }

  get checks(): Checks {
    return this.#checks;
  }

  get histogramNames(): readonly string[] {
    return [...this.#histograms.keys()].sort(compareNames);
  }

  get trendNames(): readonly string[] {
    return [...this.#trends.keys()].sort(compareNames);
  }

  /** Histogram and trend recordings refused by the cardinality cap, plus the tallies' own. */
  get refusedCount(): number {
    return this.#refusedCount + this.#counters.refusedCount + this.#checks.refusedCount;
  }

  /** Merges every metric into a new `ScenarioMetrics`; neither operand is touched. */
  merge(other: ScenarioMetrics): ScenarioMetrics {
    const merged = ScenarioMetrics.#of(
      mergeByName(
        this.#histograms,
        other.#histograms,
        () => new Histogram(),
        (a, b) => a.merge(b),
      ),
      mergeByName(
        this.#trends,
        other.#trends,
        () => new Trend(),
        (a, b) => a.merge(b),
      ),
      this.#counters.merge(other.#counters),
      this.#checks.merge(other.#checks),
    );
    merged.#refusedCount = this.#refusedCount + other.#refusedCount;
    return merged;
  }

  toSnapshot(): ScenarioSnapshot {
    return {
      histograms: mapByName(this.#histograms, (histogram) => histogram.toSnapshot()),
      trends: mapByName(this.#trends, (trend) => trend.toSnapshot()),
      counters: this.#counters.toSnapshot(),
      checks: this.#checks.toSnapshot(),
      refusedCount: this.#refusedCount,
    };
  }

  static #of(
    histograms: ReadonlyMap<string, Histogram>,
    trends: ReadonlyMap<string, Trend>,
    counters: Counters,
    checks: Checks,
  ): ScenarioMetrics {
    const built = new ScenarioMetrics();
    for (const [name, histogram] of histograms) {
      built.#histograms.set(name, histogram);
    }
    for (const [name, trend] of trends) {
      built.#trends.set(name, trend);
    }
    built.#counters = counters;
    built.#checks = checks;
    return built;
  }
}

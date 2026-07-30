import { compareNames, mapByName, mergeByName } from "./by-name.ts";
import { ScenarioMetrics } from "./scenario-metrics.ts";
import type { RegistrySnapshot } from "./snapshots.ts";
import { assertScenarioName, assertTally } from "./validate.ts";

/**
 * The metrics a worker owns: histograms, trends, counters and checks, namespaced per scenario.
 *
 * Workers never share this — no locks, no `SharedArrayBuffer`. They post cumulative snapshots and
 * the main thread merges them, which is only sound because `merge` is exact, associative and
 * commutative (D1-02, D1-03).
 *
 * As in `ScenarioMetrics`, recording and reading are separate surfaces: `scenario(name)` creates
 * on first use, `findScenario(name)` never does.
 */
export class MetricsRegistry {
  readonly #scenarios = new Map<string, ScenarioMetrics>();

  static fromSnapshot(snapshot: RegistrySnapshot): MetricsRegistry {
    return MetricsRegistry.#of(
      mapByName(snapshot.scenarios, (scenario) => ScenarioMetrics.fromSnapshot(scenario)),
    );
  }

  /**
   * Get-or-create — the recording surface.
   *
   * Unlike metric names, an out-of-bounds scenario name throws: it comes from the config, so it
   * fails identically on every run, at startup (see `validate.ts`).
   */
  scenario(name: string): ScenarioMetrics {
    assertScenarioName(this.#scenarios, name);
    const existing = this.#scenarios.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = new ScenarioMetrics();
    this.#scenarios.set(name, created);
    return created;
  }

  /** Non-mutating lookup — `undefined` for a scenario that never ran. */
  findScenario(name: string): ScenarioMetrics | undefined {
    return this.#scenarios.get(name);
  }

  hasScenario(name: string): boolean {
    return this.#scenarios.has(name);
  }

  get scenarioNames(): readonly string[] {
    return [...this.#scenarios.keys()].sort(compareNames);
  }

  /** Merges every scenario into a new registry; neither operand is touched. */
  merge(other: MetricsRegistry): MetricsRegistry {
    return MetricsRegistry.#of(
      mergeByName(
        this.#scenarios,
        other.#scenarios,
        () => new ScenarioMetrics(),
        (a, b) => a.merge(b),
      ),
    );
  }

  /**
   * @param sequence the worker's own monotonically increasing snapshot counter. Supplied rather
   * than generated here: `metrics/` owns no clock and no counter of its own, and the number only
   * means anything relative to the other snapshots that same worker posted.
   */
  toSnapshot(sequence: number): RegistrySnapshot {
    assertTally(sequence, "Snapshot sequence");
    return {
      sequence,
      scenarios: mapByName(this.#scenarios, (scenario) => scenario.toSnapshot()),
    };
  }

  static #of(scenarios: ReadonlyMap<string, ScenarioMetrics>): MetricsRegistry {
    const built = new MetricsRegistry();
    for (const [name, scenario] of scenarios) {
      built.#scenarios.set(name, scenario);
    }
    return built;
  }
}

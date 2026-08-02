import { compareNames, mapByName, mergeByName } from "./by-name.ts";
import type { CountersSnapshot } from "./snapshots.ts";
import {
  admitsMetricName,
  assertMetricName,
  assertTally,
  MAX_DISTINCT_TALLIES,
} from "./validate.ts";

/**
 * Named integer counters — `reserved201`, `conflict409`, the numbers open-ticket's contract runs
 * assert on. Monotonic on purpose: counters only go up, which is what makes a *cumulative* worker
 * snapshot safe to replace and re-merge (D1-03).
 *
 * Distinct names are capped and refusals are counted rather than thrown or dropped — see
 * `validate.ts` for why cardinality is handled differently from an outright invalid name.
 */
export class Counters {
  readonly #totals = new Map<string, number>();
  #refusedCount = 0;

  static fromSnapshot(snapshot: CountersSnapshot): Counters {
    const restored = new Counters();
    for (const [name, total] of snapshot.totals) {
      restored.#totals.set(name, total);
    }
    restored.#refusedCount = snapshot.refusedCount;
    return restored;
  }

  /**
   * Claims a name at zero, so a later `inc` of it can never be refused for cardinality.
   *
   * The cap exists to bound memory against names built from response data. That is a rule about
   * *user* names; an engine counter refused because a user filled the map turns a published number
   * into a lie — the run reports no drops because the drop counter never got a slot. Reserving is
   * how a name says "I am part of the accounting, not part of the cardinality".
   *
   * Still budgeted: a reserved name occupies a slot like any other, because pretending otherwise
   * would make the cap describe something other than the size of the map.
   */
  reserve(name: string): void {
    assertMetricName(name, "counter");
    if (this.#totals.has(name)) {
      return;
    }
    if (!admitsMetricName(this.#totals, name, MAX_DISTINCT_TALLIES)) {
      this.#refusedCount += 1;
      return;
    }
    this.#totals.set(name, 0);
  }

  inc(name: string, by = 1): void {
    assertMetricName(name, "counter");
    assertTally(by, `Counter "${name}" increment`);

    if (!admitsMetricName(this.#totals, name, MAX_DISTINCT_TALLIES)) {
      this.#refusedCount += 1;
      return;
    }
    this.#totals.set(name, (this.#totals.get(name) ?? 0) + by);
  }

  /** 0 for a counter that was never incremented — an absent counter counted nothing. */
  get(name: string): number {
    return this.#totals.get(name) ?? 0;
  }

  get names(): readonly string[] {
    return [...this.#totals.keys()].sort(compareNames);
  }

  /** Increments refused by the name-length or cardinality cap. Reported, never hidden. */
  get refusedCount(): number {
    return this.#refusedCount;
  }

  /** Addition into a new `Counters`; neither operand is touched. */
  merge(other: Counters): Counters {
    return Counters.fromSnapshot({
      totals: mergeByName(
        this.#totals,
        other.#totals,
        () => 0,
        (a, b) => a + b,
      ),
      refusedCount: this.#refusedCount + other.#refusedCount,
    });
  }

  toSnapshot(): CountersSnapshot {
    return {
      totals: mapByName(this.#totals, (total) => total),
      refusedCount: this.#refusedCount,
    };
  }
}

import { compareNames, mapByName, mergeByName } from "./by-name.ts";
import type { ChecksSnapshot, CheckTally } from "./snapshots.ts";
import { admitsMetricName, assertMetricName, MAX_DISTINCT_TALLIES } from "./validate.ts";

/**
 * Every tally that leaves this module is frozen.
 *
 * `readonly` is a compile-time promise, and `Checks` ships in `dist` for plain JS to consume. The
 * shared `NOTHING_RECORDED` is what `get` returns for an unknown name, what `record` starts from
 * and what `mergeByName` uses as its identity, so one consumer writing to it would poison every
 * `Checks` in the process — and writing to a *known* tally would go straight through into the next
 * snapshot. Freezing costs nothing here and removes the whole class of failure.
 */
const tallyOf = (passed: number, failed: number): CheckTally => Object.freeze({ passed, failed });

const NOTHING_RECORDED = tallyOf(0, 0);

const addTallies = (a: CheckTally, b: CheckTally): CheckTally =>
  tallyOf(a.passed + b.passed, a.failed + b.failed);

/**
 * Named pass/fail tallies — `"no double sell"`, `"got exactly one 201"`. A check is what turns a
 * run from a benchmark into an assertion, so both sides are kept: a check with zero failures and a
 * check that never ran are different facts, and a threshold has to be able to tell them apart.
 *
 * Distinct names are capped and refusals counted, as for `Counters`.
 */
export class Checks {
  readonly #tallies = new Map<string, CheckTally>();
  #refusedCount = 0;

  static fromSnapshot(snapshot: ChecksSnapshot): Checks {
    const restored = new Checks();
    for (const [name, tally] of snapshot.tallies) {
      restored.#tallies.set(name, tallyOf(tally.passed, tally.failed));
    }
    restored.#refusedCount = snapshot.refusedCount;
    return restored;
  }

  record(name: string, passed: boolean): void {
    assertMetricName(name, "check");

    if (!admitsMetricName(this.#tallies, name, MAX_DISTINCT_TALLIES)) {
      this.#refusedCount += 1;
      return;
    }
    const current = this.#tallies.get(name) ?? NOTHING_RECORDED;
    this.#tallies.set(name, addTallies(current, passed ? tallyOf(1, 0) : tallyOf(0, 1)));
  }

  /** A frozen `{ passed: 0, failed: 0 }` for a check that never ran. */
  get(name: string): CheckTally {
    return this.#tallies.get(name) ?? NOTHING_RECORDED;
  }

  get names(): readonly string[] {
    return [...this.#tallies.keys()].sort(compareNames);
  }

  /** Recordings refused by the name-length or cardinality cap. Reported, never hidden. */
  get refusedCount(): number {
    return this.#refusedCount;
  }

  /** Addition into a new `Checks`; neither operand is touched. */
  merge(other: Checks): Checks {
    return Checks.fromSnapshot({
      tallies: mergeByName(this.#tallies, other.#tallies, () => NOTHING_RECORDED, addTallies),
      refusedCount: this.#refusedCount + other.#refusedCount,
    });
  }

  toSnapshot(): ChecksSnapshot {
    return {
      tallies: mapByName(this.#tallies, (tally) => tallyOf(tally.passed, tally.failed)),
      refusedCount: this.#refusedCount,
    };
  }
}

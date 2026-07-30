import type { ArrivalProfile } from "./arrival-profiles.ts";

/**
 * One run, several scenarios, one dispatch order.
 *
 * D1-05: a run is a list of scenarios, not one scenario, because open-ticket's contract run 3 is
 * heavy reads *while* writes contend — and read p99 averaged with write p99 destroys the exact
 * asymmetry that measurement exists to show. Each scenario keeps its own profile and its own
 * metric namespace; the only thing they share is the dispatch loop, which needs them as a single
 * ascending stream.
 *
 * Pure, like the profiles it merges: no clock, no I/O.
 */

/** A scenario, as far as scheduling is concerned. */
export interface ScheduledScenario {
  readonly name: string;
  readonly profile: ArrivalProfile;
}

export interface ScheduledDispatch<TScenario extends ScheduledScenario> {
  readonly scenario: TScenario;
  /** ms from run start. */
  readonly instantMs: number;
  /** Ordinal within its own scenario, from 0. */
  readonly index: number;
}

interface Head<TScenario extends ScheduledScenario> {
  readonly scenario: TScenario;
  readonly instants: Iterator<number>;
  /** The instant this scenario wants next, or `undefined` once its profile is exhausted. */
  instantMs: number | undefined;
  index: number;
}

const advance = <TScenario extends ScheduledScenario>(head: Head<TScenario>): void => {
  const result = head.instants.next();
  head.instantMs = result.done === true ? undefined : result.value;
};

/**
 * Merges every scenario's profile into one ascending stream of dispatches.
 *
 * Lazy end to end — one live generator per scenario and one instant of lookahead each, so a run of
 * six million dispatches costs a handful of numbers rather than an array. K-way merge by linear
 * scan over the heads: a run holds at most a few dozen scenarios, and at that K a heap costs
 * readability while buying nothing measurable.
 *
 * Ties go to the scenario listed first in the run, and the scan keeps them there (`<`, not `<=`).
 * That is not cosmetic: a burst run puts every scenario's instants on t = 0, and a dispatch order
 * that depended on iteration luck would make two runs of the same config disagree about which
 * request reached the target first.
 */
export function* mergedSchedule<TScenario extends ScheduledScenario>(
  scenarios: readonly TScenario[],
): Generator<ScheduledDispatch<TScenario>> {
  const heads: Head<TScenario>[] = scenarios.map((scenario) => {
    const head: Head<TScenario> = {
      scenario,
      instants: scenario.profile.instants()[Symbol.iterator](),
      instantMs: undefined,
      index: 0,
    };
    advance(head);
    return head;
  });

  for (;;) {
    let earliest: Head<TScenario> | undefined;
    let earliestInstantMs = Number.POSITIVE_INFINITY;
    for (const head of heads) {
      if (head.instantMs !== undefined && head.instantMs < earliestInstantMs) {
        earliest = head;
        earliestInstantMs = head.instantMs;
      }
    }
    if (earliest === undefined) {
      return;
    }

    yield { scenario: earliest.scenario, instantMs: earliestInstantMs, index: earliest.index };
    earliest.index += 1;
    advance(earliest);
  }
}

import { MetricsRegistry } from "./registry.ts";
import { parseRegistrySnapshot } from "./snapshot-parse.ts";
import type { RegistrySnapshot } from "./snapshots.ts";

/**
 * The main thread's side of the worker metrics protocol (D1-03).
 *
 * Workers post **cumulative** snapshots — the whole story so far, not a delta — on a timer for the
 * live TUI plus a final one at the end. So aggregating is "keep the newest per worker, re-merge
 * them all", and `update` never accumulates. That is what makes a dropped or duplicated message
 * harmless: replaying the same snapshot ten times gives the same aggregate as receiving it once.
 *
 * "Newest" is decided by the worker-assigned `sequence`, not by arrival order. Arrival order is
 * only trustworthy while every snapshot from a worker travels one ordered port, and the worker
 * pool has not committed to that — a final snapshot sent from an exit handler or a second
 * `MessageChannel` would arrive out of order and, without the sequence, silently rewind the
 * aggregate to an earlier cumulative total. Reordering has to be as harmless as the other two.
 *
 * Nothing here touches a port or a clock, so the property the whole worker architecture rests on
 * is testable without spawning a thread.
 */
export class SnapshotAggregator {
  readonly #latest = new Map<string, RegistrySnapshot>();
  #supersededCount = 0;

  /**
   * Records `snapshot` as everything `workerId` has measured so far, unless a newer one is held.
   *
   * Takes `unknown` deliberately: this is where a `postMessage` payload enters, so it is where the
   * narrowing happens — once, here, rather than as guards further in that an `as`-cast at the call
   * site would step around. Throws `SnapshotFormatError` if the message is not a snapshot.
   *
   * @returns whether the snapshot advanced this worker's state.
   */
  update(workerId: string, snapshot: unknown): boolean {
    const parsed = parseRegistrySnapshot(snapshot);
    const held = this.#latest.get(workerId);
    if (held !== undefined && parsed.sequence <= held.sequence) {
      this.#supersededCount += 1;
      return false;
    }
    this.#latest.set(workerId, parsed);
    return true;
  }

  get workerCount(): number {
    return this.#latest.size;
  }

  /**
   * Snapshots ignored as stale or duplicated. Not an error — the protocol exists to tolerate them
   * — but a run whose workers keep re-sending old totals is worth seeing in a diagnostic.
   */
  get supersededCount(): number {
    return this.#supersededCount;
  }

  /** The merged view of every worker heard from so far. Recomputed, never accumulated. */
  aggregate(): MetricsRegistry {
    let merged = new MetricsRegistry();
    for (const snapshot of this.#latest.values()) {
      merged = merged.merge(MetricsRegistry.fromSnapshot(snapshot));
    }
    return merged;
  }
}

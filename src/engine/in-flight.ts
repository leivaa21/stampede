import type { Clock } from "./ports.ts";

/** How often the drain re-checks. Only ever costs the tail of a run, never a dispatch instant. */
const DRAIN_POLL_MS = 5;

/**
 * The requests the generator is still waiting on.
 *
 * Open-loop dispatch never asks this set for permission — that is the point of D1-01, and the
 * dispatcher checks `count` against the run's cap rather than awaiting anything. What the set is
 * for is the two things a run that outpaces its target has to be honest about: how many requests
 * were outstanding at once, and how many never came back at all.
 */
export class InFlight {
  readonly #pending = new Set<Promise<void>>();
  #maxObserved = 0;

  get count(): number {
    return this.#pending.size;
  }

  /** High-water mark of concurrent outstanding requests over the whole run. */
  get maxObserved(): number {
    return this.#maxObserved;
  }

  /** @param settled must never reject — the dispatcher folds both outcomes into it first. */
  track(settled: Promise<void>): void {
    const tracked = settled.finally(() => {
      this.#pending.delete(tracked);
    });
    this.#pending.add(tracked);
    this.#maxObserved = Math.max(this.#maxObserved, this.#pending.size);
  }

  /**
   * Waits for the outstanding requests, giving up after `timeoutMs`.
   *
   * A run against a target that has stopped answering must still end and still publish what it
   * measured; waiting forever would turn a hung target into a hung load test with no report at
   * all. Whatever is still outstanding when this returns is the abandoned count.
   *
   * Polling rather than racing a timer against the pending set: a race leaves the losing timer
   * alive, which keeps the Node process up after the run is over, and cancelling it would mean
   * widening the clock port for a case worth five milliseconds at the very end of a run.
   */
  async drain(clock: Clock, timeoutMs: number): Promise<void> {
    const startedAtMs = clock.now();
    while (this.#pending.size > 0) {
      const remainingMs = timeoutMs - (clock.now() - startedAtMs);
      if (remainingMs <= 0) {
        return;
      }
      await clock.sleep(Math.min(DRAIN_POLL_MS, remainingMs));
    }
  }
}

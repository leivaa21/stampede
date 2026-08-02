import type { Clock } from "../engine/ports.ts";

/**
 * A `Clock` whose time only moves when a test moves it — the reason `Clock` is a port at all.
 *
 * D1-01's guarantee is a claim about what the numbers say **when the generator wakes up late**, so
 * asserting it needs a clock that can be made to wake up late on purpose. `oversleepNext` is that
 * knob; everything else here is bookkeeping to keep a run deterministic without a single real
 * sleep in the test suite.
 *
 * Sleepers observe their own deadline exactly: advancing sets `now` to the earliest wake-up before
 * resolving it, so a fake target that "takes 50 ms" is measured as having taken 50 ms and not as
 * having taken however far the test happened to jump.
 */

interface Sleeper {
  readonly wakeAtMs: number;
  /** Creation order, so simultaneous sleepers wake in the order they were registered. */
  readonly order: number;
  readonly wake: () => void;
}

/** A run that needs more wake-ups than this is looping; failing beats hanging a test suite. */
const MAX_WAKES = 200_000;

/** Drains the microtask queue (and lets any real I/O land) before time is allowed to move again. */
const flushJobs = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const byWakeOrder = (a: Sleeper, b: Sleeper): number =>
  a.wakeAtMs - b.wakeAtMs || a.order - b.order;

export class FakeClock implements Clock {
  #nowMs = 0;
  #order = 0;
  #sleepers: Sleeper[] = [];
  readonly #oversleepMs: number[] = [];

  now(): number {
    return this.#nowMs;
  }

  /**
   * Moves time forward without waking anything — wall clock spent inside a synchronous callback.
   *
   * Distinct from `sleep`/`oversleepNext`, which are the loop waiting. This is how a test spends
   * time the way a user's slow `check` does: the clock advances, no timer fires, and nothing else
   * gets a turn.
   */
  burn(durationMs: number): void {
    this.#nowMs += Math.max(0, durationMs);
  }

  sleep(durationMs: number): Promise<void> {
    const wakeAtMs = this.#nowMs + Math.max(0, durationMs);
    this.#order += 1;
    const order = this.#order;
    return new Promise<void>((wake) => {
      this.#sleepers.push({ wakeAtMs, order, wake });
    });
  }

  /**
   * Makes the next wake-ups happen late by the given amounts, in order — a generator that was busy
   * elsewhere when its timer came due. Everything that fell due in the meantime wakes at once,
   * exactly as an overloaded real loop would find it.
   *
   * **The lag lands on whichever sleeper wakes next, not on the dispatcher specifically.** In the
   * honesty tests that is always the dispatcher only because they pair this with a target that
   * answers instantly. Give that target a latency and `FakeTransport`'s own `clock.sleep` can win
   * the race instead — the test still passes, while measuring something else entirely. This is the
   * knob the whole D1-01 assertion rests on, so keep the target instant when using it.
   */
  oversleepNext(...extraMs: readonly number[]): void {
    this.#oversleepMs.push(...extraMs);
  }

  /** @returns whether anything was waiting. */
  async advanceToNextWake(): Promise<boolean> {
    const earliest = this.#sleepers.reduce<Sleeper | undefined>(
      (best, sleeper) => (best === undefined || byWakeOrder(sleeper, best) < 0 ? sleeper : best),
      undefined,
    );
    if (earliest === undefined) {
      return false;
    }

    this.#nowMs = Math.max(this.#nowMs, earliest.wakeAtMs + (this.#oversleepMs.shift() ?? 0));
    const due = this.#sleepers.filter((sleeper) => sleeper.wakeAtMs <= this.#nowMs);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.wakeAtMs > this.#nowMs);
    for (const sleeper of due.sort(byWakeOrder)) {
      sleeper.wake();
    }

    await flushJobs();
    return true;
  }

  /** Runs the fake timeline until nothing is waiting on it any more. */
  async runToCompletion(): Promise<void> {
    await flushJobs();
    for (let wakes = 0; wakes < MAX_WAKES; wakes += 1) {
      if (!(await this.advanceToNextWake())) {
        return;
      }
    }
    throw new Error(`FakeClock: nothing settled within ${String(MAX_WAKES)} wake-ups`);
  }
}

/**
 * The reference target's projection: a queue of recorded events applied at a fixed rate.
 *
 * Extracted from the server and made pure — every method takes `now` — because this is the arbiter
 * of the repo's headline lag claim, and an arbiter with no tests is an assertion nobody checked.
 * The server owns sockets and timers; this owns the model, and `projection.test.ts` owns the proof.
 *
 * `behindMs` is open-ticket's definition, literally: **now minus the recorded time of the last
 * applied event, and 0 when caught up.** Not "now minus the oldest unapplied", which is a different
 * number — that one measures the age of the backlog's head rather than the staleness of the view,
 * and it is what a projection would report if it were grading its own homework.
 */
export class Projection {
  readonly #unapplied: number[] = [];
  #lastAppliedAtMs: number | undefined;
  #maxBehindAtRecordMs = 0;

  readonly #perTick: number;

  /**
   * @param perTick events applied per {@link tick}. Below the arrival rate, the projection falls
   * behind — which is the condition open-ticket's contract run 4 exists to measure.
   */
  constructor(perTick: number) {
    // A field and an assignment, not a parameter property: Node strips types without compiling
    // them, and a parameter property is one of the three constructs that rules out. The project's
    // own erasable-syntax rule, which the gate's target had to learn the same way a user would.
    this.#perTick = perTick;
  }

  /** Records an event and returns the lag *at that instant*, which is what a response carries. */
  record(nowMs: number): number {
    this.#unapplied.push(nowMs);
    const behind = this.behindMs(nowMs);
    // Latched here, at the instant a sale was accepted, rather than sampled on the tick.
    //
    // A free-running peak keeps climbing after the load stops — the backlog drains at `perTick`
    // while the clock runs on — so the number a reader compares against would depend on how long
    // the gate took to get around to asking. Latching makes the target's peak the maximum over
    // exactly the instants the responses reported, which is the set stampede's trend should have
    // merged: same instants, two independent paths, and any divergence is the merge's.
    this.#maxBehindAtRecordMs = Math.max(this.#maxBehindAtRecordMs, behind);
    return behind;
  }

  /** Applies up to `perTick` events. */
  tick(): void {
    for (let applied = 0; applied < this.#perTick && this.#unapplied.length > 0; applied += 1) {
      this.#lastAppliedAtMs = this.#unapplied.shift();
    }
  }

  behindMs(nowMs: number): number {
    if (this.#unapplied.length === 0) {
      return 0;
    }
    // Before the first tick there is no applied event, so the oldest unapplied one is the best
    // available answer — the projection's view is as stale as the first thing it has not seen. The
    // guard above means the array is non-empty, so `[0]` is always there; `?? nowMs` only satisfies
    // `noUncheckedIndexedAccess`, and reads as 0 lag rather than as a number nobody meant.
    const lastApplied = this.#lastAppliedAtMs ?? this.#unapplied[0] ?? nowMs;
    return Math.round(nowMs - lastApplied);
  }

  /** The peak lag any recorded event observed. Stops moving when recording stops. */
  get maxBehindAtRecordMs(): number {
    return this.#maxBehindAtRecordMs;
  }

  get unappliedCount(): number {
    return this.#unapplied.length;
  }
}

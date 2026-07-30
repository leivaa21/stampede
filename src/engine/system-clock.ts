import { setImmediate as nextEventLoopTurn, setTimeout as delay } from "node:timers/promises";
import type { Clock } from "./ports.ts";

/**
 * The only place in the engine that touches real time.
 *
 * `performance.now()` rather than `Date.now()`: it is monotonic, so a clock resynchronisation
 * mid-run cannot produce a negative latency, and it has sub-millisecond resolution, which
 * `Date.now()` does not — at a thousand requests per second an integer-millisecond clock would
 * quantise every latency the tool reports.
 *
 * A non-positive sleep goes to `setImmediate`, not to a zero-delay timer, and the difference is
 * the achievable dispatch rate: `setTimeout(…, 0)` is clamped to ~1 ms, so routing the
 * dispatcher's "give the event loop a turn" through it would cap the loop at roughly a thousand
 * dispatch batches per second no matter what rate the config asked for.
 */
export const systemClock: Clock = {
  now: (): number => performance.now(),

  sleep: async (durationMs: number): Promise<void> => {
    if (durationMs <= 0) {
      await nextEventLoopTurn();
      return;
    }
    await delay(durationMs);
  },
};

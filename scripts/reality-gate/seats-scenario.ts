import { threadId } from "node:worker_threads";
import { defineConfig } from "../../src/config/index.ts";
import { constantRate } from "../../src/engine/arrival-profiles.ts";

/**
 * Contract runs 2 and 4 — "hot show, many seats" — as the gate's workers import it.
 *
 * The whole point is the `index` argument: each buyer reserves a **different** seat, and the
 * ordinal has to be the *run's*, not the shard's. Four workers each numbering from 0 would send
 * four buyers to `seat-0` and the target would answer three of them 409 — so a failure of the
 * stride mapping cannot hide here. The referee's own count of distinct seats is the check.
 *
 * `behindMs` comes back in the response body: the reference target applies sales to a projection
 * at a fixed rate, so it falls behind while the writes keep coming. Recording it as a trend is
 * contract run 4's shape, produced with the same machinery.
 *
 * **Sustained rather than a burst**, and that is what run 4 needs: a burst of 200 finishes in
 * milliseconds, so every response is answered before the projection has fallen behind at all, and
 * the run would record a serene 0 for a projection that hit 350ms a moment later. A lag has to be
 * observable while it is happening.
 */

export interface SeatGateState {
  readonly url: string;
}

export const RATE_PER_SECOND = 100;
export const DURATION_MS = 2_000;
export const WORKER_COUNT = 4;

const profile = constantRate({ ratePerSecond: RATE_PER_SECOND, durationMs: DURATION_MS });

/**
 * Read off the profile, not re-derived from its inputs.
 *
 * `rate × duration / 1000` happens to equal `profile.count` today. It stops the moment the rate and
 * duration stop dividing evenly, and then the gate would be asserting against a number the profile
 * never produced — a claim that looks independent and is not.
 */
export const BUYERS = profile.count;

interface ReservationBody {
  readonly behindMs?: number;
}

export default defineConfig<SeatGateState>({
  scenarios: {
    buyers: {
      profile,
      request: (state, index) => ({
        method: "POST",
        url: `${state.url}seats/seat-${String(index)}`,
      }),
      checks: {
        // One seat each, so every buyer should win. A 409 here means two buyers were handed the
        // same ordinal — the exact bug the stride split exists to prevent.
        created: (response) => response.status === 201,
      },
      onResponse: (response, record) => {
        if (response.status === 201) {
          record.count("reserved201");
        }
        // One counter per worker thread, so the gate can assert the schedule really was split four
        // ways. Without it every claim in this run passes with `workerCount: 1`, while the run's
        // title and the README both lean on "4 threads".
        record.count(`thread-${String(threadId)}`);
        const body = JSON.parse(response.text) as ReservationBody;
        if (typeof body.behindMs === "number") {
          record.recordMs("behindMs", body.behindMs);
        }
      },
    },
  },
});

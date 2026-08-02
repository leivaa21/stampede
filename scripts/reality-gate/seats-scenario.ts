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
/** Derived, so the gate's claims cannot drift away from the profile they are checking. */
export const BUYERS = (RATE_PER_SECOND * DURATION_MS) / 1000;

interface ReservationBody {
  readonly behindMs?: number;
}

export default defineConfig<SeatGateState>({
  scenarios: {
    buyers: {
      profile: constantRate({ ratePerSecond: RATE_PER_SECOND, durationMs: DURATION_MS }),
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
        const body = JSON.parse(response.text) as ReservationBody;
        if (typeof body.behindMs === "number") {
          record.recordMs("behindMs", body.behindMs);
        }
      },
    },
  },
});

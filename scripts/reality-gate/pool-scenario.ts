import { defineConfig } from "../../src/config/index.ts";
import { constantRate } from "../../src/engine/arrival-profiles.ts";

/**
 * The config the pool's workers import during the reality gate.
 *
 * A separate file rather than a closure, because that is the whole point: `request` is a function
 * and functions cannot cross a `postMessage`, so a worker is given a path and imports the work
 * itself. Only the setup **state** travels — here, the URL the gate's target is listening on.
 *
 * The profile is fixed rather than taken from the setup state: a profile is evaluated when the
 * module is imported, before any state exists. The gate asserts against these exact numbers.
 */

export interface PoolGateState {
  readonly url: string;
}

export const RATE_PER_SECOND = 240;
export const DURATION_MS = 2_000;

export default defineConfig<PoolGateState>({
  scenarios: {
    reads: {
      profile: constantRate({ ratePerSecond: RATE_PER_SECOND, durationMs: DURATION_MS }),
      request: (state) => ({ url: state.url }),
    },
  },
});

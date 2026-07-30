import { constantRate } from "../../src/engine/arrival-profiles.ts";
import type { Transport, TransportResponse } from "../../src/engine/ports.ts";
import type { Scenario } from "../../src/engine/run-spec.ts";

/**
 * The module the pool's workers import during the reality gate.
 *
 * A separate file rather than a closure, because that is the whole point: functions cannot cross a
 * `postMessage`, so a worker is given a path and imports the work itself. This is the shape PR 5's
 * config loader will produce from a user's `scenarios.ts` — the seam exists now so the pool can be
 * proven against a real target before the loader is written.
 */

interface PoolSetupState {
  readonly url: string;
  readonly ratePerSecond: number;
  readonly durationMs: number;
}

interface HttpRequest {
  readonly url: string;
}

const httpTransport: Transport<HttpRequest> = {
  async send(request): Promise<TransportResponse> {
    const response = await fetch(request.url);
    await response.arrayBuffer();
    return { status: response.status };
  },
};

export default (
  setupState: unknown,
): { scenarios: readonly Scenario<HttpRequest>[]; transport: Transport<HttpRequest> } => {
  const state = setupState as PoolSetupState;
  return {
    scenarios: [
      {
        name: "reads",
        profile: constantRate({
          ratePerSecond: state.ratePerSecond,
          durationMs: state.durationMs,
        }),
        request: { url: state.url },
      },
    ],
    transport: httpTransport,
  };
};

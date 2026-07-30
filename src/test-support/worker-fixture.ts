import { burst, constantRate } from "../engine/arrival-profiles.ts";
import type { Transport, TransportResponse } from "../engine/ports.ts";
import type { Scenario } from "../engine/run-spec.ts";

/**
 * The module a worker imports in the pool's tests — a stand-in for the user's `scenarios.ts`.
 *
 * It exists as a real file rather than a mock because the thing under test *is* the boundary: a
 * worker resolves a path, imports it in its own isolate with Node stripping the types, and calls
 * the default export with the setup state. A mocked module would skip every part of that.
 */

export interface FixtureSetupState {
  readonly kind: "burst" | "rate";
  readonly count: number;
  readonly durationMs?: number;
  /** ms the fake target takes to answer. `0` answers on the next microtask. */
  readonly latencyMs?: number;
  /** When true the target rejects, so the run records errors instead of latencies. */
  readonly fails?: boolean;
}

interface FixtureRequest {
  readonly label: string;
}

const OK = 200;

const makeTransport = (state: FixtureSetupState): Transport<FixtureRequest> => ({
  async send(): Promise<TransportResponse> {
    if (state.latencyMs !== undefined && state.latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, state.latencyMs));
    }
    if (state.fails === true) {
      throw new Error("fixture target refused");
    }
    return { status: OK };
  },
});

const scenariosFor = (state: FixtureSetupState): readonly Scenario<FixtureRequest>[] => [
  {
    name: "reads",
    profile:
      state.kind === "burst"
        ? burst({ count: state.count })
        : constantRate({
            ratePerSecond: state.count,
            durationMs: state.durationMs ?? 1_000,
          }),
    request: { label: "reads" },
  },
];

export default (
  setupState: unknown,
): {
  scenarios: readonly Scenario<FixtureRequest>[];
  transport: Transport<FixtureRequest>;
} => {
  const state = setupState as FixtureSetupState;
  return { scenarios: scenariosFor(state), transport: makeTransport(state) };
};

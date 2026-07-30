import { appendFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
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
  /**
   * Makes exactly one shard fail to load, leaving its siblings running a long schedule.
   *
   * That asymmetry is the only way to test that the pool tears down workers it is no longer
   * waiting on: when *every* worker fails, they all exit by themselves and a missing teardown
   * looks identical to a working one.
   */
  readonly failOnShard?: number;
  /**
   * A file each dispatch appends a byte to — proof of life for a worker still running.
   *
   * Node's `getActiveResourcesInfo()` does not report worker threads, so "did the pool actually
   * terminate its workers" is not observable from the parent by inspection. A file that stops
   * growing is.
   */
  readonly heartbeatPath?: string;
}

interface FixtureRequest {
  readonly label: string;
}

const OK = 200;

const makeTransport = (state: FixtureSetupState): Transport<FixtureRequest> => ({
  async send(): Promise<TransportResponse> {
    if (state.heartbeatPath !== undefined) {
      appendFileSync(state.heartbeatPath, ".");
    }
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
  const shardIndex = (workerData as { shardIndex?: number } | null)?.shardIndex;
  if (state.failOnShard !== undefined && state.failOnShard === shardIndex) {
    throw new Error(`fixture refused to load on shard ${String(shardIndex)}`);
  }
  return { scenarios: scenariosFor(state), transport: makeTransport(state) };
};

import { workerData } from "node:worker_threads";
import { defineConfig } from "../config/index.ts";
import { burst, constantRate } from "../engine/arrival-profiles.ts";

/**
 * The config a worker imports in the pool's tests — a stand-in for the user's `scenarios.ts`.
 *
 * A real file rather than a mock, because the thing under test *is* the boundary: a worker resolves
 * a path, imports it in its own isolate with Node stripping the types, and builds its requests from
 * the setup state. A mocked module would skip every part of that.
 *
 * It reads `workerData` at module scope, which a real config would never do — a fixture has to vary
 * the load per test where a real config hard-codes it, and the profile is fixed at import time.
 */

export interface FixtureSetupState {
  /** Where the requests go. The tests point this at a server they started themselves. */
  readonly url: string;
  readonly kind: "burst" | "rate";
  readonly count: number;
  readonly durationMs?: number;
  /**
   * Makes exactly one shard fail to load, leaving its siblings running a long schedule.
   *
   * That asymmetry is the only way to test that the pool tears down workers it is no longer waiting
   * on: when *every* worker fails they all exit by themselves, and a missing teardown looks
   * identical to a working one.
   */
  readonly failOnShard?: number;
  /** Declare a check that always passes, one that always fails, and one that throws. */
  readonly withChecks?: boolean;
  /** Count one `seen` per response, so the pool tests can prove counters merge across threads. */
  readonly withCounter?: boolean;
}

const assignment = workerData as
  { readonly setupState?: FixtureSetupState; readonly shardIndex?: number } | null | undefined;

// Imported on the main thread too (the CLI loads the config there to run `setup`), where there is
// no `workerData` — so the fallback keeps the module importable outside a worker.
const state: FixtureSetupState = assignment?.setupState ?? {
  url: "http://127.0.0.1:1/",
  kind: "burst",
  count: 1,
};

if (state.failOnShard !== undefined && state.failOnShard === assignment?.shardIndex) {
  throw new Error(`fixture refused to load on shard ${String(assignment.shardIndex)}`);
}

export default defineConfig<FixtureSetupState>({
  scenarios: {
    reads: {
      ...(state.withChecks === true
        ? {
            checks: {
              alwaysPasses: () => true,
              alwaysFails: () => false,
              alwaysThrows: (): boolean => {
                throw new Error("a broken check");
              },
            },
          }
        : {}),
      ...(state.withCounter === true
        ? {
            onResponse: (_response: unknown, record: { count: (name: string) => void }): void => {
              record.count("seen");
            },
          }
        : {}),
      profile:
        state.kind === "burst"
          ? burst({ count: state.count })
          : constantRate({
              ratePerSecond: state.count,
              durationMs: state.durationMs ?? 1_000,
            }),
      request: (setupState) => ({ url: setupState.url }),
    },
  },
});

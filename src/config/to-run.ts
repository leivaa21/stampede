import { availableParallelism } from "node:os";
import type { HttpRequestSpec } from "../engine/http-transport.ts";
import { DEFAULT_DRAIN_TIMEOUT_MS, type Scenario } from "../engine/run-spec.ts";
import type { StampedeConfig } from "./types.ts";

/**
 * Turning a validated config into the shape the engine runs.
 *
 * This is the seam the worker pool was built against: a worker imports the user's file itself and
 * calls this, because the `request` builder is a function and functions cannot be cloned across a
 * `postMessage` (D1-04). The setup **state** travels; the code that uses it does not.
 */

export const DEFAULT_MAX_IN_FLIGHT = 1_000;
// The drain default is the engine's, imported rather than restated: two constants for one meaning
// are free to drift, and the one that drifts is always the one the report was generated with.

/**
 * One thread per core, less one for the main thread which renders and merges.
 *
 * Floored at 1 rather than 0 — a machine reporting a single core should still run the test, just
 * without a spare. Capped by the scenario's own needs is *not* done here: how many threads a run
 * deserves is the user's call, and guessing it would quietly change the load they asked for.
 */
export const defaultWorkerCount = (): number => Math.max(1, availableParallelism() - 1);

export const scenariosFrom = (
  config: StampedeConfig<unknown>,
  setupState: unknown,
): readonly Scenario<HttpRequestSpec>[] =>
  Object.entries(config.scenarios).map(([name, scenario]) => ({
    name,
    profile: scenario.profile,
    // Built once per scenario, here, rather than per dispatch: the engine's request is one value
    // for the whole scenario today. When per-request variation lands this is the line that changes.
    request: scenario.request(setupState),
  }));

export const workerCountFor = (config: StampedeConfig<unknown>): number =>
  config.workers ?? defaultWorkerCount();

export const maxInFlightFor = (config: StampedeConfig<unknown>): number =>
  config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

export const drainTimeoutMsFor = (config: StampedeConfig<unknown>): number =>
  config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

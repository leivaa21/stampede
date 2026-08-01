import type { StampedeConfig } from "./types.ts";

/**
 * The scenario config's public surface.
 *
 * `defineConfig` does nothing at runtime and everything in the editor: it anchors `TSetup`, so the
 * state `setup()` returns is the state every `request(state)` and `teardown(state)` is typed
 * against, with no annotations anywhere in the user's file. That inference *is* the DSL — the
 * non-goals rule out a scripting language precisely because TypeScript already is one.
 */
export const defineConfig = <TSetup = undefined>(
  config: StampedeConfig<TSetup>,
): StampedeConfig<TSetup> => config;

export { ConfigLoadError, assertConfigShape, configUrlFor, loadConfig } from "./load.ts";
export {
  DEFAULT_MAX_IN_FLIGHT,
  defaultWorkerCount,
  drainTimeoutMsFor,
  maxInFlightFor,
  scenariosFrom,
  workerCountFor,
} from "./to-run.ts";
export type { ScenarioConfig, StampedeConfig, Threshold } from "./types.ts";

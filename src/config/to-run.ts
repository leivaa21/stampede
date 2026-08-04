import { availableParallelism } from "node:os";
import type { HttpRequestSpec } from "../engine/http-transport.ts";
import { DEFAULT_DRAIN_TIMEOUT_MS, type Scenario } from "../engine/run-spec.ts";
import { ConfigLoadError } from "./errors.ts";
import { deepFreeze, isFrozenStateViolation } from "./freeze-state.ts";
import type { StampedeConfig } from "./types.ts";

/**
 * Turning a validated config into the shape the engine runs.
 *
 * This is the seam the worker pool was built against: a worker imports the user's file itself and
 * calls this, because the `request` builder is a function and functions cannot be cloned across a
 * `postMessage` (D1-04). The setup **state** travels; the code that uses it does not.
 */

export const DEFAULT_MAX_IN_FLIGHT = 1_000;

/**
 * The most worker threads a run may ask for.
 *
 * Unbounded, a fat-fingered `--workers 10000` does not produce a stampede diagnostic — it produces
 * a **V8 native abort**: `Assertion failed: (0) == (uv_thread_create(...))`, a stack dump, and a
 * dead process with no exit code, no report and nothing said. That directly contradicts what this
 * repo promises about its own errors, and it is not catchable after the fact, so it has to be a
 * bound checked before the threads are asked for.
 *
 * Four per core rather than one: oversubscription is a legitimate thing to measure when the
 * bottleneck is the target rather than the CPU.
 */
export const maxWorkerCount = (): number => Math.max(4, availableParallelism() * 4);
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

/**
 * Checks what `request()` actually returned.
 *
 * `request: (state) => state.url` is the natural slip — the parameter *is* the state and the state
 * often *is* a URL — and without this it produces a run where every dispatch fails inside `fetch`.
 * Every transport failure lands in one undifferentiated error counter, so the user's first run
 * would report "5 errors" and nothing else, indistinguishable from a refused connection.
 *
 * Checked here because this is the seam that has the scenario's name and runs once, at startup.
 */
const assertRequestShape = (built: unknown, name: string): HttpRequestSpec => {
  if (typeof built !== "object" || built === null || Array.isArray(built)) {
    throw new TypeError(
      `scenario "${name}": request() must return an object like { url }, got ${typeof built === "object" ? "an array" : typeof built}`,
    );
  }
  const { url } = built as { url?: unknown };
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError(`scenario "${name}": request() must return a \`url\` string`);
  }
  // `fetch("data:text/plain,hi")` answers 200 in about no time and touches no network, so a
  // typo'd or accidentally-constructed `data:` URL yields a run where every request "succeeds",
  // every threshold passes, and the report says PASSED over a sub-millisecond p50. That is the
  // most convincing false-green this tool can produce, and it is refused at the one seam that
  // runs once and knows the scenario's name.
  if (!/^https?:\/\//i.test(url)) {
    throw new TypeError(
      `scenario "${name}": request() returned a non-HTTP url (${url.slice(0, 40)}). ` +
        `stampede measures HTTP(S); a data: or file: URL would answer instantly and publish a run that never touched a network.`,
    );
  }
  return built as HttpRequestSpec;
};

/**
 * Turns the `TypeError` a frozen state throws into the contract it violates.
 *
 * Without this the user sees "Cannot delete property '2' of [object Array]" from inside
 * `Array.prototype.pop`, which names neither the scenario, nor `request()`, nor the rule. The
 * throw is the enforcement; this is the part that makes it a diagnosis.
 */
const purityErrorFor = (error: unknown, name: string): Error =>
  new ConfigLoadError(
    `scenario "${name}": request() mutated the setup state, so it is not a pure function of ` +
      `(state, ordinal). Every worker gets its own structured clone, so a builder that consumes ` +
      `shared state — \`state.seats.pop()\` — hands each thread the same values instead of ` +
      `distinct ones. Derive from the ordinal instead: \`seats[ordinal % seats.length]\`. ` +
      `(${error instanceof Error ? error.message : String(error)})`,
  );

const eagerlyValidatedBuilder = (
  scenario: StampedeConfig<unknown>["scenarios"][string],
  setupState: unknown,
  name: string,
): ((ordinal: number) => HttpRequestSpec) => {
  const build = (ordinal: number): HttpRequestSpec => {
    try {
      return assertRequestShape(scenario.request(setupState, ordinal), name);
    } catch (error: unknown) {
      // Only a frozen-state violation is translated. Anything else the builder throws is the
      // build failure the dispatcher already counts, and rewriting it as a purity error would
      // send a reader to the wrong contract.
      throw isFrozenStateViolation(error) ? purityErrorFor(error, name) : error;
    }
  };
  build(0);
  return build;
};

export const scenariosFrom = (
  config: StampedeConfig<unknown>,
  setupState: unknown,
): readonly Scenario<HttpRequestSpec>[] => {
  // Frozen here: this runs once per worker, on the copy a builder can actually reach. Freezing on
  // the main thread would protect nothing, because `structuredClone` does not preserve frozenness.
  const frozen = deepFreeze(setupState);

  return Object.entries(config.scenarios).map(([name, scenario]) => ({
    name,
    profile: scenario.profile,
    // Built once per dispatch (D2-02's accepted cost), but validated **eagerly at ordinal 0** so
    // the common mistake — returning a string, or forgetting the url — fails at startup with the
    // scenario named, rather than as a wall of counted build errors twenty minutes in.
    requestFor: eagerlyValidatedBuilder(scenario, frozen, name),
    checks: scenario.checks,
    // `{ keys: [...] }` unwrapped: the config's shape exists so the declaration has somewhere to
    // grow, and the engine has no use for the wrapper.
    keyedCounters: Object.fromEntries(
      Object.entries(scenario.counters ?? {}).map(([counter, { keys }]) => [counter, keys]),
    ),
    onResponse: scenario.onResponse,
  }));
};

export const workerCountFor = (config: StampedeConfig<unknown>): number =>
  config.workers ?? defaultWorkerCount();

export const maxInFlightFor = (config: StampedeConfig<unknown>): number =>
  config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

export const drainTimeoutMsFor = (config: StampedeConfig<unknown>): number =>
  config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

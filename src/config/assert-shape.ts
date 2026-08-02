import { brokenCheckCounter, RESERVED_METRIC_PREFIX } from "../engine/metric-names.ts";
import {
  MAX_CHECKS_PER_SCENARIO,
  MAX_DISTINCT_SCENARIOS,
  MAX_METRIC_NAME_LENGTH,
} from "../metrics/validate.ts";
import { ConfigLoadError } from "./load.ts";
import type { StampedeConfig } from "./types.ts";

/**
 * Everything a config must be true of, checked before a single request goes out.
 *
 * Split out of `load.ts`, which had become a file about two different things: turning Node's loader
 * errors into something actionable, and validating what came back. This is the half that grows —
 * every feature adds a shape to check — so it gets its own file rather than pushing the loader into
 * the middle of the validators, which is where it had ended up.
 *
 * All of it **throws at startup** rather than refusing and counting. That is `metrics/validate.ts`'s
 * rule: config-derived input fails identically on every run, so failing loudly before any load is
 * generated costs nothing, while the same mistake found twenty minutes in costs the run. Names built
 * from response data get the opposite treatment, for the opposite reason.
 */

/**
 * An object, and specifically **not an array**.
 *
 * `typeof [] === "object"`, so a plain record check accepts `scenarios: [ … ]` — and then
 * `Object.keys` yields `"0"`, `"1"`, … and every scenario is silently renamed to its index. The run
 * succeeds, the target is hit, and the report has a section called `0` while the user's threshold
 * reads `s.scenarios.reads` and finds nothing. The array form is not exotic: it is what
 * `RunSpec.scenarios` is internally, and what k6-shaped muscle memory produces.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertName = (name: string, what: string, configPath: string): void => {
  if (name.length === 0) {
    throw new ConfigLoadError(`${configPath}: a ${what} name must not be empty`);
  }
  // The engine's own counters share the metric map with the user's. A check called
  // `stampede.dropped` would collide with the drop count, and a report that says a run dropped
  // nothing when it dropped four hundred requests is the one failure this tool cannot have.
  // Config-derived, so it is a startup error — `observe.ts` refuses the same prefix at runtime for
  // names built from response data, where throwing would kill a run mid-flight.
  if (name.startsWith(RESERVED_METRIC_PREFIX)) {
    throw new ConfigLoadError(
      `${configPath}: ${what} name "${name}" starts with \`${RESERVED_METRIC_PREFIX}\`, which is reserved for stampede's own metrics — rename it`,
    );
  }
  if (name.length > MAX_METRIC_NAME_LENGTH) {
    throw new ConfigLoadError(
      `${configPath}: ${what} name is ${String(name.length)} characters; the limit is ${String(MAX_METRIC_NAME_LENGTH)}`,
    );
  }
};

/**
 * Refuses an `async` check or `onResponse` at load time, by name.
 *
 * TypeScript assigns `async (r) => r.status === 201` to a `(r) => boolean` parameter without a
 * word of complaint — the return type becomes `Promise<boolean>`, which is truthy, never `false`,
 * and would have made every check pass forever. `observe.ts` catches this at runtime too (it has
 * to: a config can hand back a function it built itself), but by then the answer is a broken-check
 * count in a report. Here it is a message naming the check and the fix, before a request goes out.
 */
const assertNotAsync = (fn: unknown, what: string, configPath: string): void => {
  // Read through the prototype rather than a hard-coded reference to a global: `AsyncFunction` is
  // not one, and a function bound or wrapped by the config still reports it here.
  const kind = (fn as { readonly constructor?: { readonly name?: unknown } }).constructor?.name;
  if (kind === "AsyncFunction") {
    throw new ConfigLoadError(
      `${configPath}: ${what} is \`async\`, so it returns a promise rather than a value — ` +
        `stampede reads it synchronously on the response path. Drop the \`async\` keyword.`,
    );
  }
};

/**
 * Config-derived numbers, checked here rather than where they are used.
 *
 * `metrics/validate.ts` calls itself "the backstop, not the front door" and asks this loader to
 * reject these earlier — which matters because by the time a worker refuses a name, N threads have
 * spawned and `setup()` has already created state on the user's system. This function is also the
 * only place that knows the filename.
 */
const assertOptionalNumber = (
  value: unknown,
  key: string,
  configPath: string,
  integer: boolean,
): void => {
  if (value === undefined) {
    return;
  }
  const ok = integer
    ? typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    : typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!ok) {
    throw new ConfigLoadError(
      `${configPath}: \`${key}\` must be ${integer ? "a whole number of at least 1" : "a non-negative number of milliseconds"}, got ${JSON.stringify(value)}`,
    );
  }
};

/**
 * The assertion surface a scenario declares: named checks, and the observer that feeds counters.
 *
 * Split out of `assertConfigShape` when it passed the workspace's ~200-line signal. Each of these
 * rejections exists because the mistake it catches type-checks perfectly and fails silently at
 * runtime — which is why they are startup errors and not something a reader has to notice in a
 * report twenty minutes later.
 */
const assertObservers = (
  scenario: Record<string, unknown>,
  name: string,
  configPath: string,
): void => {
  const { checks, onResponse } = scenario;
  if (checks !== undefined) {
    if (!isRecord(checks)) {
      throw new ConfigLoadError(
        `${configPath}: scenario "${name}" has \`checks\` that is not an object of named predicates`,
      );
    }
    // Each check reserves a counter slot for its broken tally, from the same budget the user's
    // own counters draw on. Left unbounded, a config could starve itself and then be told its
    // counters were the problem.
    if (Object.keys(checks).length > MAX_CHECKS_PER_SCENARIO) {
      throw new ConfigLoadError(
        `${configPath}: scenario "${name}" declares ${String(Object.keys(checks).length)} checks; the limit is ${String(MAX_CHECKS_PER_SCENARIO)}`,
      );
    }
    for (const [checkName, predicate] of Object.entries(checks)) {
      // Named here rather than left to fail per response: a check is a claim, and a claim with
      // no predicate is a claim nobody is making.
      assertName(checkName, "check", configPath);
      if (typeof predicate !== "function") {
        throw new ConfigLoadError(
          `${configPath}: check "${checkName}" in scenario "${name}" must be a function taking a response`,
        );
      }
      // A broken check is attributed by a counter derived from its name, and the metrics
      // registry *silently refuses* a name over the limit rather than throwing — so a check
      // named right up to the limit would lose its attribution at exactly the moment someone
      // needed it. Budgeted here, where the name can still be changed.
      if (brokenCheckCounter(checkName).length > MAX_METRIC_NAME_LENGTH) {
        throw new ConfigLoadError(
          `${configPath}: check name "${checkName}" is too long — a check name may be at most ` +
            `${String(MAX_METRIC_NAME_LENGTH - brokenCheckCounter("").length)} characters`,
        );
      }
      assertNotAsync(predicate, `check "${checkName}" in scenario "${name}"`, configPath);
    }
  }
  if (onResponse !== undefined) {
    if (typeof onResponse !== "function") {
      throw new ConfigLoadError(
        `${configPath}: scenario "${name}" has an \`onResponse\` that is not a function`,
      );
    }
    assertNotAsync(onResponse, `\`onResponse\` in scenario "${name}"`, configPath);
  }
};

/** Threshold names are what a failing CI job prints, so they are validated like identifiers. */
const assertThresholds = (thresholds: unknown, configPath: string): void => {
  if (thresholds !== undefined) {
    if (!Array.isArray(thresholds)) {
      throw new ConfigLoadError("`thresholds` must be an array");
    }
    const seen = new Set<string>();
    for (const [index, threshold] of thresholds.entries()) {
      if (
        !isRecord(threshold) ||
        typeof threshold.name !== "string" ||
        typeof threshold.assert !== "function"
      ) {
        throw new ConfigLoadError(
          `${configPath}: thresholds[${String(index)}] must be { name: string, assert: (summary) => boolean }`,
        );
      }
      assertName(threshold.name, "threshold", configPath);
      // D1-06 makes the name the thing a CI failure prints, so two thresholds sharing one is a
      // report that cannot say which claim broke.
      if (seen.has(threshold.name)) {
        throw new ConfigLoadError(
          `${configPath}: two thresholds are both named "${threshold.name}" — the name is what a failing run prints`,
        );
      }
      seen.add(threshold.name);
    }
  }
};

/** One scenario: when it dispatches, what it sends, and what it claims about the answers. */
const assertScenario = (scenario: unknown, name: string, configPath: string): void => {
  assertName(name, "scenario", configPath);
  if (!isRecord(scenario)) {
    throw new ConfigLoadError(`${configPath}: scenario "${name}" must be an object`);
  }
  if (typeof scenario.request !== "function") {
    throw new ConfigLoadError(
      `${configPath}: scenario "${name}" needs a \`request\` function — it receives your setup state and returns the request to send`,
    );
  }
  const { profile } = scenario;
  if (!isRecord(profile) || typeof profile.instants !== "function") {
    throw new ConfigLoadError(
      `${configPath}: scenario "${name}" needs a \`profile\` — use constantRate(), ramp(), burst() or stages()`,
    );
  }
  // A hand-built `{ instants }` would otherwise be typed as an ArrivalProfile and reach
  // `shardProfile` as NaN, surfacing inside a worker as a number the user never wrote.
  if (!Number.isSafeInteger(profile.count) || Number(profile.count) < 0) {
    throw new ConfigLoadError(
      `${configPath}: scenario "${name}" has a profile with no valid \`count\` — build it with constantRate(), ramp(), burst() or stages()`,
    );
  }
  if (!Number.isFinite(profile.durationMs) || Number(profile.durationMs) < 0) {
    throw new ConfigLoadError(
      `${configPath}: scenario "${name}" has a profile with no valid \`durationMs\``,
    );
  }
  assertObservers(scenario, name, configPath);

  // A scenario that schedules nothing would sail past the "recorded no responses" guard — it
  // dispatched nothing, so nothing failed — and reach the thresholds with `latencyMs` undefined,
  // where `(s.p99 ?? 0) < 250` passes. A green CI job for a load test that sent zero requests is
  // the exact lie D1-06 exists to prevent, reached through a different door. Rates that round
  // down are the usual cause: 2/s for 100ms is 0.2 requests, floored to none.
  if (profile.count === 0) {
    throw new ConfigLoadError(
      `${configPath}: scenario "${name}" schedules 0 requests over ${String(profile.durationMs)}ms — ` +
        `a rate that rounds down to nothing, most likely. Raise the rate or lengthen the duration.`,
    );
  }
};

/**
 * Checks the shape of a loaded config before a single request goes out.
 *
 * Everything here is config-derived, so it **throws at startup** rather than being refused and
 * counted — the same config fails identically on every run, and a mistake found before the load
 * starts costs nothing, while the same mistake found twenty minutes in costs the run.
 */
export const assertConfigShape: (
  value: unknown,
  configPath: string,
) => asserts value is StampedeConfig<unknown> = (value, configPath) => {
  if (!isRecord(value)) {
    throw new ConfigLoadError(`${configPath} must export a config object`);
  }
  const { scenarios, setup, teardown, thresholds } = value;
  if (!isRecord(scenarios)) {
    throw new ConfigLoadError(`${configPath} must declare a \`scenarios\` object`);
  }
  const names = Object.keys(scenarios);
  if (names.length === 0) {
    throw new ConfigLoadError(`${configPath} declares no scenarios — a run needs at least one`);
  }
  if (names.length > MAX_DISTINCT_SCENARIOS) {
    throw new ConfigLoadError(
      `${configPath} declares ${String(names.length)} scenarios; the limit is ${String(MAX_DISTINCT_SCENARIOS)}`,
    );
  }
  for (const name of names) {
    assertScenario(scenarios[name], name, configPath);
  }
  assertOptionalNumber(value.workers, "workers", configPath, true);
  assertOptionalNumber(value.maxInFlight, "maxInFlight", configPath, true);
  assertOptionalNumber(value.drainTimeoutMs, "drainTimeoutMs", configPath, false);
  for (const [key, fn] of [
    ["setup", setup],
    ["teardown", teardown],
  ] as const) {
    if (fn !== undefined && typeof fn !== "function") {
      throw new ConfigLoadError(`\`${key}\` must be a function if present`);
    }
  }
  assertThresholds(thresholds, configPath);
};

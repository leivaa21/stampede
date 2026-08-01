import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_DISTINCT_SCENARIOS, MAX_METRIC_NAME_LENGTH } from "../metrics/validate.ts";
import type { StampedeConfig } from "./types.ts";

/**
 * Loading a user's `scenarios.ts`.
 *
 * D1-04: Node 24 strips the types itself, so there is no bundler, no build step, no dependency, and
 * — the deciding property — *identical* behaviour here and inside a worker, which is what lets each
 * worker import the same file rather than be handed something that cannot be cloned.
 *
 * The price is **erasable syntax only**: no `enum`, no parameter properties, no `namespace`. Node
 * says so precisely and this module says it again in terms of the file the user actually wrote,
 * because a raw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` stack is not an answer to "what do I change?".
 */

export class ConfigLoadError extends Error {
  override readonly name = "ConfigLoadError";
}

const TYPE_STRIPPING_HELP = [
  "stampede loads your config with Node's type stripping, which erases types without compiling",
  "them, so the file must use erasable syntax only:",
  "",
  "  • `enum Foo {}`            → `const Foo = { … } as const`",
  "  • `constructor(private x)` → declare the field and assign it",
  "  • `namespace Foo {}`       → a module, or a plain object",
].join("\n");

/**
 * Resolves a user-supplied path to a `file:` URL, and refuses anything that is not a path.
 *
 * Handed straight to `import()`, a bare string would also accept `data:` URLs — which execute
 * inline — and bare specifiers, which resolve out of `node_modules`. Running the config *is*
 * arbitrary code execution by design (same trust model as a vitest or tsup config), but a thing the
 * user typed as a path should only ever be read as a path.
 *
 * The guarantee comes entirely from `pathToFileURL`, which holds unconditionally. The `existsSync`
 * above it is an **error-message gate, not a security gate** — worth saying, so a later "this stat
 * is redundant, `import()` throws anyway" cleanup removes the check and not the guard.
 */
export const configUrlFor = (configPath: string): URL => {
  const absolute = path.resolve(configPath);
  if (!existsSync(absolute)) {
    throw new ConfigLoadError(`No config file at ${absolute}`);
  }
  return pathToFileURL(absolute);
};

const describeImportFailure = (configPath: string, error: unknown): ConfigLoadError => {
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = (cause as { code?: unknown }).code;

  if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
    // Node names the construct ("TypeScript enum is not supported in strip-only mode"), which is
    // the useful half; what it cannot say is which file the user should go and edit.
    return new ConfigLoadError(
      `${configPath} uses TypeScript syntax that cannot be stripped.\n\n${cause.message}\n\n${TYPE_STRIPPING_HELP}`,
      { cause },
    );
  }
  return new ConfigLoadError(`Could not load ${configPath}: ${cause.message}`, { cause });
};

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
  if (name.length > MAX_METRIC_NAME_LENGTH) {
    throw new ConfigLoadError(
      `${configPath}: ${what} name is ${String(name.length)} characters; the limit is ${String(MAX_METRIC_NAME_LENGTH)}`,
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
    assertName(name, "scenario", configPath);
    const scenario = scenarios[name];
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

/** Imports and validates a config file. Never returns a half-checked object. */
export const loadConfig = async (configPath: string): Promise<StampedeConfig<unknown>> => {
  const url = configUrlFor(configPath);
  let imported: unknown;
  try {
    imported = await import(url.href);
  } catch (error: unknown) {
    throw describeImportFailure(configPath, error);
  }

  const exported = (imported as { default?: unknown }).default;
  if (exported === undefined) {
    throw new ConfigLoadError(
      `${configPath} has no default export — end the file with \`export default defineConfig({ … })\``,
    );
  }
  assertConfigShape(exported, configPath);
  return exported;
};

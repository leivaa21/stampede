import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
  for (const name of names) {
    const scenario = scenarios[name];
    if (!isRecord(scenario)) {
      throw new ConfigLoadError(`scenario "${name}" must be an object`);
    }
    if (typeof scenario.request !== "function") {
      throw new ConfigLoadError(
        `scenario "${name}" needs a \`request\` function — it receives your setup state and returns the request to send`,
      );
    }
    if (!isRecord(scenario.profile) || typeof scenario.profile.instants !== "function") {
      throw new ConfigLoadError(
        `scenario "${name}" needs a \`profile\` — use constantRate(), ramp(), burst() or stages()`,
      );
    }
  }
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
    for (const [index, threshold] of thresholds.entries()) {
      if (
        !isRecord(threshold) ||
        typeof threshold.name !== "string" ||
        typeof threshold.assert !== "function"
      ) {
        throw new ConfigLoadError(
          `thresholds[${String(index)}] must be { name: string, assert: (summary) => boolean }`,
        );
      }
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

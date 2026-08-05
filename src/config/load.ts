import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertConfigShape } from "./assert-shape.ts";
import { ConfigLoadError } from "./errors.ts";
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

const TYPE_STRIPPING_HELP = [
  "stampede loads your config with Node's type stripping, which erases types without compiling",
  "them, so the file must use erasable syntax only:",
  "",
  "  • `enum Foo {}`            → `const Foo = { … } as const`",
  "  • `constructor(private x)` → declare the field and assign it",
  "  • `namespace Foo {}`       → a module, or a plain object",
].join("\n");

/** The two extensions Node strips types from. Whether either *loads as ESM* is a separate question. */
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts"]);

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
  // TypeScript-only is already what the README, `--help` and D1-04 promise — this makes the promise
  // enforced rather than assumed.
  if (!TYPESCRIPT_EXTENSIONS.has(path.extname(absolute))) {
    throw new ConfigLoadError(
      `${absolute} is not a config stampede loads — it takes \`.ts\` and \`.mts\`, whose types Node ` +
        `strips itself (D1-04). The typed config *is* the DSL, which is the one packaging opinion ` +
        `the tool holds. A \`.cts\` config is TypeScript too, but CommonJS — port it to ` +
        `\`export default\` and rename it \`.mts\`.`,
    );
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

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Whether Node will load a file as an ES module.
 *
 * This is **not** a question about the extension, which is the assumption that made the first
 * version of this gate a no-op. For `.ts` and `.js`, Node resolves the format from the nearest
 * `package.json` — and syntax detection, which rescues an ESM-looking `.js`, does not apply to
 * `.ts` at all. So in a package with `"type": "commonjs"`, or with no `"type"` (the default for
 * every project that has not opted in), a `scenarios.ts` loads as CommonJS.
 *
 * Which matters here because CommonJS runs in **sloppy mode**, where a write to a frozen object
 * fails *silently* instead of throwing. Measured on Node 24 in that exact setup: `state.nonce += 1`
 * is dropped without a word, and `state.seats[0] = "z"` with it. That is D25-02's guard turned off,
 * and worse than off — the mutation the user wrote does not happen either, so a builder meant to
 * vary its output sends the same value every time and nothing anywhere says why. (`pop()` still
 * throws; it is a spec-level throw, independent of strictness. Which is precisely why testing the
 * gate with `pop()` would prove nothing.)
 */

export type ModuleFormat = "module" | "commonjs";

interface NearestPackage {
  readonly file: string;
  readonly type: string | undefined;
}

const typeOf = (contents: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const type: unknown = (parsed as Record<string, unknown>).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    // Malformed JSON. Node fails the import outright, so anything this returns is a diagnostic for
    // a load that is about to fail anyway — and treating it as "no type" is the safe half, since it
    // makes the gate refuse rather than wave the file through.
    return undefined;
  }
};

/**
 * The nearest `package.json` at or above `fromDir` — the **first** one found, whether or not it
 * declares a `type`, because that is where Node stops looking too.
 */
const nearestPackage = (fromDir: string): NearestPackage | undefined => {
  let dir = fromDir;
  for (;;) {
    const file = path.join(dir, "package.json");
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
      continue;
    }
    return { file, type: typeOf(contents) };
  }
};

/** Where the answer came from, so an error message can point at the file the user has to edit. */
export interface ResolvedFormat {
  readonly format: ModuleFormat;
  /** The `package.json` that decided it — absent when the extension alone did. */
  readonly decidedBy: string | undefined;
}

export const resolveModuleFormat = (absolutePath: string): ResolvedFormat => {
  const extension = path.extname(absolutePath);
  // `.mts`/`.mjs` and `.cts`/`.cjs` are unambiguous by extension and outrank any `package.json`.
  if (extension === ".mts" || extension === ".mjs") {
    return { format: "module", decidedBy: undefined };
  }
  if (extension === ".cts" || extension === ".cjs") {
    return { format: "commonjs", decidedBy: undefined };
  }

  const found = nearestPackage(path.dirname(absolutePath));
  if (found === undefined) {
    // No `package.json` anywhere above the file. Node falls back to **syntax detection** here, and
    // the shape the README prescribes — `export default defineConfig(…)` — is detected as ESM and
    // runs strict; verified on Node 24. Refusing this case would reject every config in a scratch
    // directory to guard against a hole that only opens if someone deliberately writes
    // `module.exports` in a config the README never suggests.
    return { format: "module", decidedBy: undefined };
  }
  return {
    // A `package.json` with no `"type"` at all is CommonJS — the default for every project that has
    // not opted in, and the single most likely place a real user hits this.
    format: found.type === "module" ? "module" : "commonjs",
    decidedBy: found.file,
  };
};

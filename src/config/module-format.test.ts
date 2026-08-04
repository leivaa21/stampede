import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveModuleFormat } from "./module-format.ts";

/**
 * The question this answers is the one the first version of the CommonJS gate got wrong: a `.ts`
 * file's module system comes from the nearest `package.json`, not from its extension.
 */

const dirWith = (pkg: string | undefined): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "stampede-format-"));
  if (pkg !== undefined) {
    writeFileSync(path.join(dir, "package.json"), pkg);
  }
  return dir;
};

describe("resolveModuleFormat", () => {
  it('calls a .ts file CommonJS under "type": "commonjs"', () => {
    // Measured on Node 24: this file runs *sloppy*, so a write to the frozen setup state is
    // silently dropped and D25-02 is a no-op. It is the whole reason this module exists.
    const dir = dirWith('{"type":"commonjs"}');

    expect(resolveModuleFormat(path.join(dir, "scenarios.ts")).format).toBe("commonjs");
  });

  it("calls it CommonJS when package.json has no type at all — the common case", () => {
    // The default for every project that has not opted in, which makes it the likeliest way a
    // real user meets this, not an exotic one.
    const dir = dirWith("{}");

    expect(resolveModuleFormat(path.join(dir, "scenarios.ts")).format).toBe("commonjs");
  });

  it('calls it ESM under "type": "module"', () => {
    const dir = dirWith('{"type":"module"}');

    expect(resolveModuleFormat(path.join(dir, "scenarios.ts")).format).toBe("module");
  });

  it("names the package.json that decided it, so the error can point at a file to edit", () => {
    const dir = dirWith("{}");

    expect(resolveModuleFormat(path.join(dir, "scenarios.ts")).decidedBy).toBe(
      path.join(dir, "package.json"),
    );
  });

  it("stops at the first package.json found, whether or not it declares a type", () => {
    // Node stops there too. Walking past it to a grandparent that says `"type": "module"` would
    // report ESM for a file Node loads as CommonJS — the exact inversion this guard must not make.
    const outer = dirWith('{"type":"module"}');
    const inner = path.join(outer, "nested");
    mkdirSync(inner);
    writeFileSync(path.join(inner, "package.json"), "{}");

    expect(resolveModuleFormat(path.join(inner, "scenarios.ts")).format).toBe("commonjs");
  });

  it("finds a package.json further up when the config sits in a subdirectory", () => {
    const outer = dirWith('{"type":"module"}');
    const inner = path.join(outer, "load-tests");
    mkdirSync(inner);

    expect(resolveModuleFormat(path.join(inner, "scenarios.ts")).format).toBe("module");
  });

  it("lets the extension outrank package.json for .mts and .cts", () => {
    const dir = dirWith('{"type":"commonjs"}');

    expect(resolveModuleFormat(path.join(dir, "scenarios.mts")).format).toBe("module");
    expect(resolveModuleFormat(path.join(dir, "scenarios.cts")).format).toBe("commonjs");
  });

  it("treats a file with no package.json above it as ESM, because detection applies there", () => {
    // Verified on Node 24: with no package.json anywhere, `export default …` in a `.ts` file loads
    // as an ES module and runs strict. Refusing this would reject every config in a scratch
    // directory — including this suite's own fixtures.
    const dir = mkdtempSync(path.join(tmpdir(), "stampede-format-"));

    expect(resolveModuleFormat(path.join(dir, "scenarios.ts"))).toEqual({
      format: "module",
      decidedBy: undefined,
    });
  });

  it("refuses rather than waves through when package.json is malformed", () => {
    // Node fails that import outright, so this only decides which message the user sees — and the
    // safe half is the one that refuses.
    const dir = dirWith("{ not json");

    expect(resolveModuleFormat(path.join(dir, "scenarios.ts")).format).toBe("commonjs");
  });
});

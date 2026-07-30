import { describe, expect, it } from "vitest";
import { readVersion } from "./version.ts";

describe("readVersion", () => {
  it("reads the version out of this package's package.json", () => {
    const version = readVersion(new URL("../package.json", import.meta.url));

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("fails loudly when the file has no version field", () => {
    expect(() => readVersion(new URL("../tsconfig.json", import.meta.url))).toThrow(/version/);
  });

  it("names the file it could not read instead of leaking a bare parse error", () => {
    // The repo promises actionable errors, never raw stack traces — an unguarded JSON.parse
    // would surface a bare "Unexpected token" with no indication of which file was at fault.
    expect(() => readVersion(new URL("../LICENSE", import.meta.url))).toThrow(
      /Could not read .*LICENSE/,
    );
  });

  it("reports a missing file as unreadable rather than crashing", () => {
    expect(() => readVersion(new URL("../does-not-exist.json", import.meta.url))).toThrow(
      /Could not read/,
    );
  });
});

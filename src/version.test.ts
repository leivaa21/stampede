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
});

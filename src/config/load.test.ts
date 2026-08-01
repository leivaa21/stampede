import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./load.ts";

/**
 * Loading a user's config.
 *
 * These write real files and import them, because the whole decision under test is that **Node**
 * loads the TypeScript, not a bundler we control (D1-04). A stubbed loader would prove nothing
 * about the thing that actually runs — least of all the erasable-syntax limit, which is the one
 * constraint every user will eventually walk into.
 */

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

const writeConfig = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "stampede-config-"));
  const file = join(dir, "scenarios.ts");
  writeFileSync(file, source);
  return file;
};

const VALID = `
import { defineConfig } from "${REPO_ROOT}src/config/index.ts";
import { burst } from "${REPO_ROOT}src/engine/arrival-profiles.ts";

export default defineConfig({
  scenarios: {
    reads: { profile: burst({ count: 3 }), request: () => ({ url: "http://localhost:1/" }) },
  },
});
`;

describe("loadConfig", () => {
  it("loads a typed TypeScript config with no build step", async () => {
    const config = await loadConfig(writeConfig(VALID));

    expect(Object.keys(config.scenarios)).toEqual(["reads"]);
  });

  it("names the file when there is nothing to load", async () => {
    await expect(loadConfig("/nowhere/scenarios.ts")).rejects.toThrow(/No config file at/);
  });

  it("explains erasable-syntax-only instead of leaking Node's error", () => {
    // Run in a **real Node process**, not in vitest. Vite intercepts dynamic imports and compiles
    // TypeScript properly, so in-process this file would load happily and the test would be
    // asserting against vitest's loader rather than the one that ships. The whole point of D1-04
    // is which loader runs, so the test has to use that one.
    const file = writeConfig(
      `enum Mode { Burst }\nexport default { scenarios: {}, mode: Mode.Burst };`,
    );
    const probe = writeConfig("");

    writeFileSync(
      probe,
      `import { loadConfig } from "${REPO_ROOT}src/config/load.ts";
await loadConfig(${JSON.stringify(file)}).catch((error) => {
  process.stdout.write(String(error.message));
});`,
    );

    const message = execFileSync(process.execPath, [probe], { encoding: "utf8" });

    expect(message).toContain(file);
    expect(message).toMatch(/enum/i);
    // The fix, not just the diagnosis.
    expect(message).toContain("as const");
  });

  it("says what to write when the file has no default export", async () => {
    const file = writeConfig(`export const nope = 1;`);

    await expect(loadConfig(file)).rejects.toThrow(/export default defineConfig/);
  });

  it("refuses a config with no scenarios rather than running an empty test", async () => {
    const file = writeConfig(`export default { scenarios: {} };`);

    await expect(loadConfig(file)).rejects.toThrow(/at least one/);
  });

  it("points at the scenario that is missing a request builder", async () => {
    const file = writeConfig(`export default { scenarios: { reads: { profile: {} } } };`);

    await expect(loadConfig(file)).rejects.toThrow(/scenario "reads" needs a `request` function/);
  });

  it("points at the scenario that is missing a profile", async () => {
    const file = writeConfig(
      `export default { scenarios: { reads: { request: () => ({ url: "u" }) } } };`,
    );

    await expect(loadConfig(file)).rejects.toThrow(/constantRate\(\), ramp\(\), burst\(\)/);
  });

  it("refuses a threshold that is not a named predicate", async () => {
    const file = writeConfig(`
import { burst } from "${REPO_ROOT}src/engine/arrival-profiles.ts";
export default {
  scenarios: { reads: { profile: burst({ count: 1 }), request: () => ({ url: "u" }) } },
  thresholds: [{ name: "no assert" }],
};
`);

    await expect(loadConfig(file)).rejects.toThrow(/thresholds\[0\]/);
  });

  it("reports a config that throws while being imported", async () => {
    const file = writeConfig(`throw new Error("boom from the config");`);

    await expect(loadConfig(file)).rejects.toThrow(/boom from the config/);
  });

  it("refuses a specifier that is not a path", async () => {
    // A bare string reaching `import()` would also accept `data:` URLs, which execute inline.
    await expect(loadConfig("data:text/javascript,export default {}")).rejects.toThrow(
      /No config file at/,
    );
  });
});

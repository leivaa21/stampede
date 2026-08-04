import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

  /**
   * The assertion surface's own edges. Each of these type-checks perfectly and fails silently at
   * runtime — which is why they are startup errors rather than something a reader has to notice in
   * a report at the end of a twenty-minute run.
   */
  describe("checks and onResponse", () => {
    const withScenario = (extra: string): string =>
      VALID.replace(
        `request: () => ({ url: "http://localhost:1/" }) },`,
        `request: () => ({ url: "http://localhost:1/" }), ${extra} },`,
      );

    it("refuses an async check, which would otherwise pass forever", async () => {
      // `async (r) => r.status === 201` returns a promise. A promise is truthy and is never
      // `false`, so every response would be recorded as passing a check that verified nothing.
      await expect(
        loadConfig(writeConfig(withScenario(`checks: { created: async () => true }`))),
      ).rejects.toThrow(/check "created".*is `async`.*Drop the `async` keyword/s);
    });

    it("refuses an async onResponse", async () => {
      await expect(
        loadConfig(writeConfig(withScenario(`onResponse: async () => undefined`))),
      ).rejects.toThrow(/`onResponse` in scenario "reads" is `async`/);
    });

    it("refuses a check name in stampede's own metric namespace", async () => {
      // Otherwise the check's tally and the engine's drop counter share a key, and the run reports
      // a drop count the user wrote.
      await expect(
        loadConfig(writeConfig(withScenario(`checks: { "stampede.dropped": () => true }`))),
      ).rejects.toThrow(/check name "stampede.dropped" starts with `stampede.`, which is reserved/);
    });

    it("refuses a scenario name in that namespace too", async () => {
      await expect(
        loadConfig(writeConfig(VALID.replace("reads: {", '"stampede.internal": {'))),
      ).rejects.toThrow(/scenario name "stampede.internal" starts with/);
    });

    it("refuses a check name too long to attribute a break to", async () => {
      // The registry silently refuses an over-long name rather than throwing, so this would cost
      // the "which check broke" attribution at exactly the moment someone needed it.
      const long = "c".repeat(115);
      await expect(
        loadConfig(writeConfig(withScenario(`checks: { "${long}": () => true }`))),
        // The quoted figure is the budget minus the derived counter's prefix. Quoting the raw
        // 120 would name a length that still fails, which is worse than saying nothing.
      ).rejects.toThrow(/is too long — a check name may be at most 99 characters/);
    });

    it("says what an onResponse has to be when it is not a function", async () => {
      await expect(
        loadConfig(writeConfig(withScenario(`onResponse: "please count things"`))),
      ).rejects.toThrow(/scenario "reads" has an `onResponse` that is not a function/);
    });

    it("caps how many checks one scenario may declare", async () => {
      // Every check reserves a counter slot for its broken tally. Unbounded, a config starves its
      // own counters and is then told the counters are at fault.
      const many = Array.from({ length: 65 }, (_, i) => `c${String(i)}: () => true`).join(", ");
      await expect(loadConfig(writeConfig(withScenario(`checks: { ${many} }`)))).rejects.toThrow(
        /declares 65 checks; the limit is 64/,
      );
    });

    it("refuses declarations that would leave no room for plain counters", async () => {
      // At startup with the arithmetic shown, rather than as "recordings refused" twenty minutes
      // later. 7 × 61 slots = 427, plus the engine's own, leaves well under the floor.
      const keys = Array.from({ length: 60 }, (_, i) => `"k${String(i)}"`).join(", ");
      const many = Array.from({ length: 7 }, (_, i) => `c${String(i)}: { keys: [${keys}] }`).join(
        ", ",
      );

      await expect(
        loadConfig(writeConfig(withScenario(`counters: { ${many} }, onResponse: () => undefined`))),
      ).rejects.toThrow(
        /would leave -?\d+ of 512 counter slots free .*at least 128 must stay free/s,
      );
    });

    it("names the biggest declaration to shrink, rather than saying 'use fewer names'", async () => {
      const wide = Array.from({ length: 60 }, (_, i) => `"k${String(i)}"`).join(", ");
      const rest = Array.from({ length: 6 }, (_, i) => `c${String(i)}: { keys: [${wide}] }`).join(
        ", ",
      );
      const widest = Array.from({ length: 64 }, (_, i) => `"w${String(i)}"`).join(", ");

      await expect(
        loadConfig(
          writeConfig(
            withScenario(
              `counters: { ${rest}, widest: { keys: [${widest}] } }, onResponse: () => undefined`,
            ),
          ),
        ),
      ).rejects.toThrow(/The largest declaration is "widest" at 65; shrink that first/);
    });

    it("refuses a declaration with no `onResponse` to write to it", async () => {
      // Otherwise the run publishes `2xx 0 · 5xx 0 · other 0` and a threshold reading `["5xx"] ===
      // 0` passes green about a dimension nothing could ever have touched.
      await expect(
        loadConfig(writeConfig(withScenario(`counters: { byStatus: { keys: ["2xx"] } }`))),
      ).rejects.toThrow(/declares `counters` but has no `onResponse`/);
    });

    it("refuses a counter name too long for its implicit `other` slot", async () => {
      // 116 + ".other" is 122, over the 120-character limit — so every key loads fine and the
      // bucket that proves the key space is closed gets silently refused at runtime.
      const long = "c".repeat(116);
      await expect(
        loadConfig(
          writeConfig(
            withScenario(`counters: { "${long}": { keys: ["x"] } }, onResponse: () => undefined`),
          ),
        ),
      ).rejects.toThrow(/is too long — a keyed counter's name may be at most 114 characters/);
    });

    it("refuses two declarations whose implicit `other` slots collide", async () => {
      await expect(
        loadConfig(
          writeConfig(
            withScenario(
              `counters: { a: { keys: ["b.other"] }, "a.b": { keys: ["x"] } }, onResponse: () => undefined`,
            ),
          ),
        ),
      ).rejects.toThrow(/both store into "a\.b\.other"/);
    });

    it("refuses two declarations that would store into one slot", async () => {
      // `{ a: { keys: ["b.c"] } }` and `{ "a.b": { keys: ["c"] } }` both name `a.b.c`, so ten
      // increments would be published as twenty across two counters in the same report.
      await expect(
        loadConfig(
          writeConfig(
            withScenario(
              `counters: { a: { keys: ["b.c"] }, "a.b": { keys: ["c"] } }, onResponse: () => undefined`,
            ),
          ),
        ),
      ).rejects.toThrow(/both store into "a\.b\.c"/);
    });

    it("refuses a declared `other`, because it is implicit", async () => {
      await expect(
        loadConfig(
          writeConfig(
            withScenario(
              `counters: { byStatus: { keys: ["2xx", "other"] } }, onResponse: () => undefined`,
            ),
          ),
        ),
      ).rejects.toThrow(/declares "other" — it is implicit/);
    });

    it("refuses a duplicate key rather than silently reserving one slot", async () => {
      await expect(
        loadConfig(
          writeConfig(
            withScenario(
              `counters: { byStatus: { keys: ["2xx", "2xx"] } }, onResponse: () => undefined`,
            ),
          ),
        ),
      ).rejects.toThrow(/declares "2xx" twice/);
    });

    it("refuses an empty key space, and says what to use instead", async () => {
      await expect(
        loadConfig(
          writeConfig(
            withScenario(`counters: { byStatus: { keys: [] } }, onResponse: () => undefined`),
          ),
        ),
      ).rejects.toThrow(/declares no keys — use `record.count`/);
    });

    it("refuses a counter declared as something other than { keys: [...] }", async () => {
      await expect(
        loadConfig(
          writeConfig(withScenario(`counters: { byStatus: ["2xx"] }, onResponse: () => undefined`)),
        ),
      ).rejects.toThrow(/must be declared as \{ keys: \[\.\.\.\] \}/);
    });

    it("accepts a declared key space", async () => {
      const config = await loadConfig(
        writeConfig(
          withScenario(
            `counters: { byStatus: { keys: ["2xx", "5xx"] } }, onResponse: () => undefined`,
          ),
        ),
      );

      expect(config.scenarios.reads?.counters?.byStatus?.keys).toEqual(["2xx", "5xx"]);
    });

    it("accepts a plain synchronous check", async () => {
      const config = await loadConfig(
        writeConfig(withScenario(`checks: { created: (r) => r.status === 201 }`)),
      );

      expect(Object.keys(config.scenarios.reads?.checks ?? {})).toEqual(["created"]);
    });
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

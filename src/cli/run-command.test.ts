import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCountingServer, type CountingServer } from "../test-support/counting-server.ts";
import { ExitCode, runFromConfig } from "./run-command.ts";

/**
 * `stampede run`, end to end: config → setup → storm across threads → teardown → verdict.
 *
 * Against a real server and real worker threads, because the ordering *is* the milestone's argument
 * — an invariant like "exactly one seat sold" can only be asked after the storm, and getting that
 * order wrong is not something a mocked run would notice.
 */

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

let target: CountingServer;

beforeEach(async () => {
  target = await startCountingServer();
});

afterEach(async () => {
  await target.close();
});

const writeConfig = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "stampede-run-"));
  const file = join(dir, "scenarios.ts");
  writeFileSync(file, `import { defineConfig, burst } from "${REPO_ROOT}src/index.ts";\n${body}`);
  return file;
};

const configFor = (options: {
  url: string;
  teardown?: string;
  thresholds?: string;
  count?: number;
}): string =>
  writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(options.url)} }),
  scenarios: {
    reads: { profile: burst({ count: ${String(options.count ?? 20)} }), request: (s) => ({ url: s.url }) },
  },
  ${options.teardown ?? ""}
  ${options.thresholds ?? ""}
  workers: 2,
  maxInFlight: 40,
  drainTimeoutMs: 3000,
});`);

describe("runFromConfig", () => {
  it("runs the load and passes when every threshold holds", async () => {
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        thresholds: `thresholds: [{ name: "everything answered", assert: (s) => s.scenarios[0].responseCount === 20 }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.verdict?.violated).toEqual([]);
    expect(target.received()).toBe(20);
  }, 30_000);

  it("hands setup state to every worker", async () => {
    // The state never travels as code — only as data — so proving it arrived means proving the
    // requests went where setup said they should.
    const report = await runFromConfig({ configPath: configFor({ url: target.url }) });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(target.received()).toBe(20);
  }, 30_000);

  it("fails with exit 1 when a threshold is violated", async () => {
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        thresholds: `thresholds: [{ name: "p99 under 0ms", assert: (s) => (s.scenarios[0].latencyMs?.p99Ms ?? 1e9) < 0 }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.verdict?.violated).toEqual(["p99 under 0ms"]);
  }, 30_000);

  it("fails with exit 1 when teardown proves the invariant broke", async () => {
    // The headline case: the claim is not about any single response, it is about the state the
    // system was left in. Only teardown can ask it, and only after the storm.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        teardown: `teardown: () => { throw new Error("double sell: 2 seats sold"); },`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.failure).toContain("the invariant did not hold");
    expect(report.failure).toContain("double sell");
  }, 30_000);

  it("runs teardown after the storm, not before it", async () => {
    // The ordering *is* the milestone's argument, so it is asserted from inside the config: teardown
    // asks the target how many requests it has seen, and throws if the storm has not happened yet.
    // Run in the wrong order this fails with exit 1 rather than passing quietly.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        teardown: `teardown: async () => {
          const seen = await (await fetch(${JSON.stringify(`${target.url}__count`)})).json();
          if (seen.received < 20) {
            throw new Error("teardown ran before the storm: only " + seen.received + " requests had landed");
          }
        },`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.failure).toBeUndefined();
  }, 30_000);

  it("fails with exit 2 when nothing could be measured", async () => {
    const report = await runFromConfig({
      configPath: configFor({ url: "http://127.0.0.1:1/" }),
    });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failure).toContain("recorded no responses");
  }, 30_000);

  it("fails with exit 2 when setup itself throws", async () => {
    const configPath = writeConfig(`export default defineConfig({
  setup: () => { throw new Error("could not seed the show"); },
  scenarios: { reads: { profile: burst({ count: 1 }), request: () => ({ url: "http://127.0.0.1:1/" }) } },
});`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failure).toContain("setup() failed");
    expect(report.failure).toContain("could not seed the show");
  }, 30_000);

  it("fails with exit 2 when a threshold predicate throws", async () => {
    // A broken claim is the config's mistake, not the target's — blaming the system for it would
    // send someone hunting a race condition that was never there.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        thresholds: `thresholds: [{ name: "reaches into nothing", assert: (s) => s.nope.deeper === 1 }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.verdict?.broken).toEqual(["reaches into nothing"]);
  }, 30_000);

  it("fails with exit 2 when the config does not exist", async () => {
    const report = await runFromConfig({ configPath: "/nowhere/scenarios.ts" });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failure).toContain("No config file at");
  }, 30_000);

  it("lets --workers override what the config asked for", async () => {
    const report = await runFromConfig({
      configPath: configFor({ url: target.url, count: 12 }),
      workers: 1,
    });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.summary?.scenarios[0]?.scheduledCount).toBe(12);
  }, 30_000);
});

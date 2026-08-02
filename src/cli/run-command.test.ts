import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
        // `async`, deliberately: a synchronous throw is caught even by a `void`-ed call, so only
        // an async teardown pins that the run actually awaits it.
        teardown: `teardown: async () => { throw new Error("double sell: 2 seats sold"); },`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.failures.join(" ")).toContain("the invariant did not hold");
    expect(report.failures.join(" ")).toContain("double sell");
  }, 30_000);

  it("still evaluates thresholds when teardown failed, so both halves are reported", async () => {
    // Both land on exit 1, so returning early bought nothing and cost the reader the specific
    // half: "the seat sold twice" is the symptom; the named threshold is the claim.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        teardown: `teardown: async () => { throw new Error("double sell"); },`,
        thresholds: `thresholds: [{ name: "impossible", assert: () => false }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.failures.join(" ")).toContain("double sell");
    expect(report.verdict?.violated).toEqual(["impossible"]);
  }, 30_000);

  it("reports the double sell even when a check is also broken", async () => {
    // Two things went wrong: a predicate has a typo *and* the seat sold twice. Reporting only the
    // typo loses the double sell, which is the thing this tool exists to find. The broken claim
    // decides the exit code — a run whose assertions are unsound cannot be said to have judged the
    // target — but both sentences reach the reader.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)} }),
  scenarios: {
    reads: {
      profile: burst({ count: 20 }),
      request: (s) => ({ url: s.url }),
      checks: { parsesBody: (r) => JSON.parse("not json").ok },
    },
  },
  teardown: async () => { throw new Error("double sell: 2 sold"); },
});
`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("broken observations");
    expect(report.failures.join(" ")).toContain("double sell: 2 sold");
  }, 30_000);

  it("reports every reason a run failed, not only the first", async () => {
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)} }),
  scenarios: {
    reads: {
      profile: burst({ count: 20 }),
      request: (s) => ({ url: s.url }),
      checks: { parsesBody: (r) => JSON.parse("not json").ok },
    },
  },
  thresholds: [{ name: "throws", assert: () => { throw new Error("bad claim"); } }],
});
`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("a threshold predicate threw");
    expect(report.failures.join(" ")).toContain("broken observations");
  }, 30_000);

  it("fails with exit 2 when a config asked for more metric names than the caps allow", async () => {
    // A counter per seat is a cardinality bomb, and it reaches the cap legitimately. The refused
    // names are missing *entirely*, so a threshold reading one gets a confident 0 and reports a
    // violation the target never caused — this has to fail the run rather than pass quietly.
    const configPath = writeConfig(`let seen = 0;
export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)} }),
  scenarios: {
    reads: {
      profile: burst({ count: 600 }),
      request: (s) => ({ url: s.url }),
      // Per *worker*, unlike \`request\`: this counter is only ever read by the worker that owns it,
      // and the run is single-threaded so the names are 1..600.
      onResponse: (r, record) => { seen += 1; record.count("seat-" + String(seen)); },
    },
  },
  workers: 1,
  maxInFlight: 1000,
  drainTimeoutMs: 3000,
});
`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("refused");
    expect(report.failures.join(" ")).toContain("cardinality bomb");
    expect(report.summary?.scenarios[0]?.refusedRecordings).toBeGreaterThan(0);
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
    expect(report.failures).toEqual([]);
  }, 30_000);

  it("fails with exit 2 when nothing could be measured", async () => {
    const report = await runFromConfig({
      configPath: configFor({ url: "http://127.0.0.1:1/" }),
    });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("recorded no responses");
  }, 30_000);

  it("fails with exit 2 when setup itself throws", async () => {
    const configPath = writeConfig(`export default defineConfig({
  setup: () => { throw new Error("could not seed the show"); },
  scenarios: { reads: { profile: burst({ count: 1 }), request: () => ({ url: "http://127.0.0.1:1/" }) } },
});`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("setup() failed");
    expect(report.failures.join(" ")).toContain("could not seed the show");
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
    expect(report.failures.join(" ")).toContain("No config file at");
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

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCountingServer, type CountingServer } from "./test-support/counting-server.ts";

/**
 * The command line as CI actually invokes it — a real process, real argv, real exit code.
 *
 * In-process tests of `runFromConfig` cover the orchestration; what they cannot cover is the part
 * every CI job depends on: that the number the process exits with is the number the contract
 * promises. That only exists once something has actually exited.
 */

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the binary **asynchronously**, which is not a style preference.
 *
 * The target server lives in this process, and `spawnSync` blocks this event loop — so a
 * synchronous spawn means the server cannot answer a single request while the CLI is running, and
 * every run abandons its whole schedule. Async keeps the server alive alongside the child.
 */
const runCli = async (args: readonly string[]): Promise<CliResult> => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      status: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

let target: CountingServer;

beforeEach(async () => {
  target = await startCountingServer();
});

afterEach(async () => {
  await target.close();
});

const writeConfig = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "stampede-cli-"));
  const file = join(dir, "scenarios.ts");
  writeFileSync(file, `import { defineConfig, burst } from "${REPO_ROOT}src/index.ts";\n${body}`);
  return file;
};

const configFor = (url: string, extra = ""): string =>
  writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(url)} }),
  scenarios: { reads: { profile: burst({ count: 8 }), request: (s) => ({ url: s.url }) } },
  ${extra}
  workers: 1,
  maxInFlight: 16,
  drainTimeoutMs: 3000,
});`);

describe("the stampede binary", () => {
  it("prints help and exits 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stampede run <scenarios.ts>");
    // The exit-code contract belongs where someone reading `--help` will find it.
    expect(result.stdout).toContain("a threshold was violated");
  });

  it("exits 0 when every threshold holds", async () => {
    const result = await runCli([
      "run",
      configFor(
        target.url,
        `thresholds: [{ name: "everything answered", assert: (s) => s.scenarios[0].responseCount === 8 }],`,
      ),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
  }, 30_000);

  it("exits 1 — not 2 — when the system violated a claim", async () => {
    const result = await runCli([
      "run",
      configFor(target.url, `thresholds: [{ name: "impossible", assert: () => false }],`),
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL    impossible");
    expect(result.stderr).toContain("1 threshold(s) violated");
  }, 30_000);

  it("exits 2 — not 1 — when the tool could not run", async () => {
    // The distinction the whole contract exists for: a broken install must not report as a failed
    // invariant, or someone goes hunting a race condition that was never there.
    const result = await runCli(["run", "/nowhere/scenarios.ts"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No config file at");
  });

  it("exits 2 on an unknown flag rather than running with defaults", async () => {
    const result = await runCli(["run", "x.ts", "--wrokers", "4"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--wrokers");
  });

  it("exits 2 when a stray unhandled rejection escapes the user's config", async () => {
    // stampede executes the user's config by design. Node exits 1 on an unhandled rejection
    // regardless of `process.exitCode`, which would tell CI the *target* broke an invariant
    // because someone forgot an `await`.
    const configPath = writeConfig(`
void Promise.reject(new Error("a forgotten await in the config"));
export default defineConfig({
  scenarios: { reads: { profile: burst({ count: 1 }), request: () => ({ url: "http://127.0.0.1:1/" }) } },
});`);

    const result = await runCli(["run", configPath]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unhandled rejection");
  }, 30_000);

  it("writes a markdown report when asked, and says where", async () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "stampede-report-")), "nested", "out.md");

    const result = await runCli(["run", configFor(target.url), "--report", reportPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("report written to");
    const report = readFileSync(reportPath, "utf8");
    expect(report).toContain("## Load test");
    expect(report).toContain("### reads");
    // Directories are created rather than making the user mkdir first.
    expect(report).toContain("| percentile | latency |");
  }, 30_000);

  it("still writes the report when a threshold failed — that is when it is needed", async () => {
    const reportPath = join(mkdtempSync(join(tmpdir(), "stampede-report-")), "out.md");

    const result = await runCli([
      "run",
      configFor(target.url, `thresholds: [{ name: "impossible", assert: () => false }],`),
      "--report",
      reportPath,
    ]);

    expect(result.status).toBe(1);
    expect(readFileSync(reportPath, "utf8")).toContain("| **FAIL** | impossible |");
  }, 30_000);

  it("does not fail a passing run because the report could not be written", async () => {
    // Someone asked for a report and will go looking for it, so it is reported on stderr — but a
    // green run must not turn red over an unwritable path.
    const result = await runCli([
      "run",
      configFor(target.url),
      "--report",
      "/proc/version/nope.md",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not write the report");
  }, 30_000);

  it("does not claim thresholds were violated when teardown was what failed", async () => {
    const result = await runCli([
      "run",
      configFor(target.url, `teardown: async () => { throw new Error("double sell: 2 sold"); },`),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the invariant did not hold");
    // Thresholds are evaluated even after a teardown failure, so the verdict exists — but with
    // nothing violated, "0 threshold(s) violated" would say nothing while looking like it does.
    expect(result.stderr).not.toContain("threshold(s) violated");
  }, 30_000);
});

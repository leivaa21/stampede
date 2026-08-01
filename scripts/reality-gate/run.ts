import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { constantRate, httpTransport, runDispatch, systemClock } from "../../src/engine/index.ts";
import type { HttpRequestSpec } from "../../src/engine/http-transport.ts";
import { runPool } from "../../src/engine/worker-pool.ts";
import type { ScenarioRunSummary } from "../../src/engine/run-summary.ts";

/**
 * Gate two — the reality gate (workspace CLAUDE.md §7).
 *
 * `pnpm test` proves the engine is self-consistent. It cannot prove the engine tells the truth: the
 * fake clock in those tests is agreed on by both the implementation and the assertion, so a wrong
 * shared assumption passes twice. This drives the real dispatcher, through the real system clock,
 * over real HTTP, against a target whose behaviour is known in advance — then checks stampede's
 * numbers against the target's own count.
 *
 *   pnpm gate:two
 *
 * Exits non-zero if any claim fails, so it can gate a release the same way a threshold gates a run.
 */

const TARGET_PORT = 5999;
const TARGET_URL = `http://localhost:${String(TARGET_PORT)}/`;

/*
 * The transport here is the shipped `httpTransport`, not a copy.
 *
 * It used to be a local one — which meant the gate's headline numbers, the ones quoted in the
 * README and the current-state line, were produced by code that never ships. A regression in the
 * real transport would have left this page green while it kept claiming to have verified the tool
 * against a real target. Evidence has to run the code it is evidence for.
 */

interface TargetStats {
  readonly received: number;
  readonly completed: number;
  readonly achievedRps: number;
}

const readTargetStats = async (): Promise<TargetStats> => {
  const response = await fetch(`${TARGET_URL}__stats`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new TypeError("the target returned a malformed stats body");
  }
  const { received, completed, achievedRps } = body as Record<string, unknown>;
  if (
    typeof received !== "number" ||
    typeof completed !== "number" ||
    typeof achievedRps !== "number"
  ) {
    throw new TypeError("the target's stats are missing a count");
  }
  return { received, completed, achievedRps };
};

const startTarget = async (args: readonly string[]): Promise<ChildProcess> => {
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("target-server.ts", import.meta.url)), ...args],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  await sleep(700);
  return server;
};

let failures = 0;

const ms = (value: number | undefined): string =>
  value === undefined ? "n/a" : `${value.toFixed(1)}ms`;

const row = (label: string, value: string): void => {
  process.stdout.write(`    ${label.padEnd(42)}${value}\n`);
};

const claim = (label: string, holds: boolean, detail: string): void => {
  if (!holds) {
    failures += 1;
  }
  process.stdout.write(`    ${holds ? "PASS" : "FAIL"}  ${label} — ${detail}\n`);
};

interface GateRun {
  readonly title: string;
  readonly targetArgs: readonly string[];
  readonly ratePerSecond: number;
  readonly durationMs: number;
  readonly check: (summary: ScenarioRunSummary, stats: TargetStats) => void;
}

const gateRun = async ({
  title,
  targetArgs,
  ratePerSecond,
  durationMs,
  check,
}: GateRun): Promise<void> => {
  process.stdout.write(`\n${"─".repeat(76)}\n${title}\n${"─".repeat(76)}\n`);
  const target = await startTarget(targetArgs);
  try {
    const outcome = await runDispatch<HttpRequestSpec>(
      {
        scenarios: [
          {
            name: "reads",
            profile: constantRate({ ratePerSecond, durationMs }),
            request: { url: TARGET_URL },
          },
        ],
        maxInFlight: 500,
        drainTimeoutMs: 5_000,
      },
      { clock: systemClock, transport: httpTransport },
    );

    const summary = outcome.summary.scenarios[0];
    if (summary === undefined) {
      throw new Error("the run reported no scenario");
    }
    const stats = await readTargetStats();

    row("requested rate", `${String(summary.requestedRatePerSecond)} rps`);
    row(
      "achieved rate — stampede vs target",
      `${(summary.achievedRatePerSecond ?? 0).toFixed(0)} rps vs ${String(stats.achievedRps)} rps`,
    );
    row(
      "dispatched / dropped / errors",
      `${String(summary.dispatchedCount)} / ${String(summary.droppedCount)} / ${String(summary.errorCount)}`,
    );
    row("target received / completed", `${String(stats.received)} / ${String(stats.completed)}`);
    row(
      "latency p50 / p99 (the target)",
      `${ms(summary.latencyMs?.p50Ms)} / ${ms(summary.latencyMs?.p99Ms)}`,
    );
    row(
      "scheduledLatency p50 / p99 (D1-01)",
      `${ms(summary.scheduledLatencyMs?.p50Ms)} / ${ms(summary.scheduledLatencyMs?.p99Ms)}`,
    );
    row("schedule lag max (own backlog)", ms(summary.scheduleLagMs?.maxMs));
    process.stdout.write("\n");

    check(summary, stats);
  } finally {
    target.kill();
    await sleep(250);
  }
};

// 1. Can the instrument measure a stopwatch at all? Everything else is moot if not.
await gateRun({
  title: "RUN 1 — known-latency target: 50ms fixed delay, 20rps for 2s",
  targetArgs: ["--port", String(TARGET_PORT), "--delay", "50"],
  ratePerSecond: 20,
  durationMs: 2_000,
  check: (summary, stats) => {
    const p50 = summary.latencyMs?.p50Ms ?? 0;
    claim("p50 lands on the target's real 50ms", p50 >= 48 && p50 <= 65, `${p50.toFixed(1)}ms`);
    claim(
      "every request reached the target",
      stats.received === summary.dispatchedCount,
      `${String(stats.received)} received vs ${String(summary.dispatchedCount)} dispatched`,
    );
    claim("nothing dropped against a healthy target", summary.droppedCount === 0, "0 drops");
  },
});

// 2. Does it generate the rate it claims to?
await gateRun({
  title: "RUN 2 — fast target: 1ms delay, 100rps for 3s",
  targetArgs: ["--port", String(TARGET_PORT), "--delay", "1"],
  ratePerSecond: 100,
  durationMs: 3_000,
  check: (summary, stats) => {
    const achieved = summary.achievedRatePerSecond ?? 0;
    claim(
      "achieved rate within 5% of requested",
      Math.abs(achieved - 100) <= 5,
      `${achieved.toFixed(1)} rps`,
    );
    claim(
      "stampede's count agrees with the target's",
      Math.abs(stats.received - summary.dispatchedCount) <= 1,
      `${String(stats.received)} vs ${String(summary.dispatchedCount)}`,
    );
  },
});

// 3. The target is slower than the load offered. A closed-loop generator throttles itself here and
//    publishes the target's *service* time as if it were the user's experience.
await gateRun({
  title: "RUN 3 — target slower than asked: 200ms delay, capacity 10, asking 200rps for 3s",
  targetArgs: ["--port", String(TARGET_PORT), "--delay", "200", "--capacity", "10"],
  ratePerSecond: 200,
  durationMs: 3_000,
  check: (summary, stats) => {
    const p99 = summary.scheduledLatencyMs?.p99Ms ?? 0;
    claim(
      "reports the queue, not the 200ms isolated service time",
      p99 > 1_000,
      `p99 ${p99.toFixed(0)}ms — ${(p99 / 200).toFixed(0)}x the service time`,
    );
    claim(
      "did not throttle itself to the target's ~50rps capacity",
      summary.dispatchedCount >= 550,
      `dispatched ${String(summary.dispatchedCount)} while the target completed ${String(stats.completed)}`,
    );
    claim(
      "every scheduled request is accounted for",
      summary.scheduledCount === summary.dispatchedCount + summary.droppedCount,
      `${String(summary.scheduledCount)} = ${String(summary.dispatchedCount)} sent + ${String(summary.droppedCount)} dropped`,
    );
  },
});

// 4. The other half of D1-01: when the GENERATOR is the bottleneck, does it admit it, or quietly
//    report whatever it managed as though that were the rate it was asked for?
await gateRun({
  title: "RUN 4 — generator overload: asking 50,000rps from one thread for 2s",
  targetArgs: ["--port", String(TARGET_PORT), "--delay", "1"],
  ratePerSecond: 50_000,
  durationMs: 2_000,
  check: (summary) => {
    const achieved = summary.achievedRatePerSecond ?? 0;
    const lag = summary.scheduleLagMs?.maxMs ?? 0;
    claim(
      "admits an achieved rate far below the requested one",
      achieved < 50_000,
      `${achieved.toFixed(0)} rps of 50,000, ${String(summary.droppedCount)} dropped`,
    );
    claim("surfaces its own backlog as schedule lag", lag > 50, `${lag.toFixed(0)}ms`);
    claim(
      "the backlog lands in scheduledLatency, above raw latency",
      (summary.scheduledLatencyMs?.p99Ms ?? 0) > (summary.latencyMs?.p99Ms ?? 0),
      `${ms(summary.scheduledLatencyMs?.p99Ms)} vs ${ms(summary.latencyMs?.p99Ms)}`,
    );
  },
});

// 5. The worker pool, against the same target. Four threads must measure the run one thread would
//    have — and the target's own count is the referee, since it cannot be fooled by a merge bug.
{
  const title = "RUN 5 — worker pool: 4 threads, 240rps for 2s, cross-checked against the target";
  process.stdout.write(`\n${"─".repeat(76)}\n${title}\n${"─".repeat(76)}\n`);
  const target = await startTarget(["--port", String(TARGET_PORT), "--delay", "5"]);
  try {
    const outcome = await runPool({
      modulePath: fileURLToPath(new URL("pool-scenario.ts", import.meta.url)),
      workerCount: 4,
      maxInFlight: 400,
      drainTimeoutMs: 5_000,
      snapshotIntervalMs: 250,
      setupState: { url: TARGET_URL },
    });
    const summary = outcome.summary.scenarios[0];
    if (summary === undefined) {
      throw new Error("the pooled run reported no scenario");
    }
    const stats = await readTargetStats();

    row(
      "scheduled / dispatched / dropped",
      `${String(summary.scheduledCount)} / ${String(summary.dispatchedCount)} / ${String(summary.droppedCount)}`,
    );
    row("target received / completed", `${String(stats.received)} / ${String(stats.completed)}`);
    row(
      "achieved rate — stampede vs target",
      `${(summary.achievedRatePerSecond ?? 0).toFixed(0)} rps vs ${String(stats.achievedRps)} rps`,
    );
    row(
      "latency p50 / p99 (the target)",
      `${ms(summary.latencyMs?.p50Ms)} / ${ms(summary.latencyMs?.p99Ms)}`,
    );
    row("superseded snapshots", String(outcome.supersededSnapshots));
    process.stdout.write("\n");

    claim(
      "four shards scheduled exactly the whole run",
      summary.scheduledCount === 480,
      `${String(summary.scheduledCount)} of 480`,
    );
    claim(
      "the target saw what stampede says it sent",
      stats.received === summary.dispatchedCount,
      `${String(stats.received)} received vs ${String(summary.dispatchedCount)} dispatched`,
    );
    claim(
      "the merged accounting adds up",
      summary.scheduledCount === summary.dispatchedCount + summary.droppedCount &&
        summary.responseCount + summary.errorCount + summary.abandonedCount ===
          summary.dispatchedCount,
      `${String(summary.dispatchedCount)} sent, ${String(summary.responseCount)} answered`,
    );
    claim(
      "no snapshot arrived out of order",
      outcome.supersededSnapshots === 0,
      `${String(outcome.supersededSnapshots)} superseded`,
    );
  } finally {
    target.kill();
    await sleep(250);
  }
}

process.stdout.write(`\n${"═".repeat(76)}\n`);
process.stdout.write(
  failures === 0
    ? "GATE TWO PASSED — the numbers are true against a target that knows better\n"
    : `GATE TWO FAILED — ${String(failures)} claim(s) did not hold\n`,
);
process.stdout.write(`${"═".repeat(76)}\n`);
process.exitCode = failures === 0 ? 0 : 1;

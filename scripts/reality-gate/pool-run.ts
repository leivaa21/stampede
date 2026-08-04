import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runPool } from "../../src/engine/worker-pool.ts";
import {
  claim,
  ms,
  readTargetStats,
  row,
  section,
  startTarget,
  TARGET_PORT,
  TARGET_URL,
} from "./harness.ts";

/**
 * The worker pool, against the same target.
 *
 * Four threads must measure the run one thread would have — and the target's own count is the
 * referee, since it cannot be fooled by a merge bug.
 */
export const workerPoolRun = async (): Promise<void> => {
  section("RUN 5 — worker pool: 4 threads, 240rps for 2s, cross-checked against the target");
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
    // Against a healthy target these are zero, and saying so is the point: adding
    // `requestErrorCount` to the identity made it hold for a run with 44 request errors, where the
    // two-term version would have failed loudly. An identity that survives anything proves nothing.
    claim(
      "nothing was dropped and every request was built",
      summary.droppedCount === 0 &&
        summary.requestErrorCount === 0 &&
        summary.impureRequestCount === 0,
      `${String(summary.droppedCount)} dropped, ${String(summary.requestErrorCount)} not built + ${String(summary.impureRequestCount)} impure`,
    );
    claim(
      "the merged accounting adds up",
      summary.scheduledCount ===
        summary.dispatchedCount +
          summary.droppedCount +
          summary.requestErrorCount +
          summary.impureRequestCount &&
        summary.responseCount + summary.errorCount + summary.abandonedCount ===
          summary.dispatchedCount,
      `${String(summary.scheduledCount)} = ${String(summary.dispatchedCount)} sent + ${String(summary.droppedCount)} dropped + ${String(summary.requestErrorCount)} not built + ${String(summary.impureRequestCount)} impure; ` +
        `${String(summary.dispatchedCount)} = ${String(summary.responseCount)} answered + ${String(summary.errorCount)} failed + ${String(summary.abandonedCount)} abandoned`,
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
};

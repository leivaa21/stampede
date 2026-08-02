import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { burst, httpTransport, runDispatch, systemClock } from "../../src/engine/index.ts";
import type { HttpRequestSpec } from "../../src/engine/http-transport.ts";
import { runPool } from "../../src/engine/worker-pool.ts";
import { claim, ms, readTargetStats, row, section, startTarget, TARGET_URL } from "./harness.ts";
import { BUYERS } from "./seats-scenario.ts";

/**
 * The runs open-ticket wrote down as its load contract, produced against a target that can be
 * checked — before open-ticket itself exists.
 *
 * The rest of the gate proves stampede measures time honestly. These prove the other half of the
 * pitch: that an **invariant** survives the trip through checks, counters, a worker pool and a
 * summary, and comes out the far end agreeing with a referee that counted independently.
 */

const BUYERS_ON_ONE_SEAT = 200;

/**
 * The projection is sampled on a 50ms tick, so the peak stampede's responses observed and the peak
 * the target recorded for itself are two samples of the same curve taken at different instants.
 * One tick of slack, and no more — a trend that merged wrongly across four threads would miss by
 * far more than this.
 */
const LAG_TOLERANCE_MS = 60;

/**
 * Contract run 1 — the namesake. N buyers, one seat, and the claim is not a percentile: exactly
 * one 201, N−1 conflicts, zero double sells.
 */
export const theStampede = async (): Promise<void> => {
  section(
    `RUN 6 — contract run 1: ${String(BUYERS_ON_ONE_SEAT)} buyers, one seat, exactly one wins`,
  );
  const target = await startTarget(["--port", "5999", "--delay", "2"]);
  try {
    const outcome = await runDispatch<HttpRequestSpec>(
      {
        scenarios: [
          {
            name: "theStampede",
            profile: burst({ count: BUYERS_ON_ONE_SEAT }),
            requestFor: () => ({ method: "POST", url: `${TARGET_URL}seats/hot-seat` }),
            checks: {
              // Anything else means the target invented a third answer under contention.
              oneWinnerOrConflict: (response) => response.status === 201 || response.status === 409,
            },
            // No projection lag recorded here: 200 buyers on one seat produce exactly one sale,
            // so the target's projection has nothing to fall behind on. That number belongs to
            // run 7, where the writes are sustained and the lag is real.
            onResponse: (response, record) => {
              if (response.status === 201) {
                record.count("reserved201");
              }
            },
          },
        ],
        maxInFlight: 500,
        drainTimeoutMs: 5_000,
      },
      { clock: systemClock, transport: httpTransport },
    );

    const summary = outcome.summary.scenarios[0];
    if (summary === undefined) {
      throw new Error("the stampede run reported no scenario");
    }
    const stats = await readTargetStats();
    const winners = summary.counters.reserved201 ?? 0;
    const answered = summary.checks.oneWinnerOrConflict;

    row(
      "buyers / answered",
      `${String(summary.dispatchedCount)} / ${String(summary.responseCount)}`,
    );
    row("201s counted by stampede", String(winners));
    row("seats the target says it sold", String(stats.sold));
    row(
      "check oneWinnerOrConflict",
      `${String(answered?.passed ?? 0)} pass · ${String(answered?.failed ?? 0)} fail · ${String(answered?.broken ?? 0)} broken`,
    );
    row("latency p50 / p99", `${ms(summary.latencyMs?.p50Ms)} / ${ms(summary.latencyMs?.p99Ms)}`);
    process.stdout.write("\n");

    claim(
      "exactly one buyer won",
      winners === 1,
      `${String(winners)} of ${String(BUYERS_ON_ONE_SEAT)}`,
    );
    claim(
      "the target agrees it sold one seat",
      stats.sold === 1,
      `${String(stats.sold)} sold, counted by the target itself`,
    );
    claim(
      "every response was a win or a conflict",
      answered?.failed === 0 && answered.passed === summary.responseCount,
      `${String(answered?.passed ?? 0)} of ${String(summary.responseCount)}`,
    );
    claim(
      "no claim was broken",
      summary.brokenObservations === 0,
      `${String(summary.brokenObservations)} broken observations`,
    );
  } finally {
    target.kill();
    await sleep(250);
  }
};

/**
 * Contract runs 2 and 4 — N buyers across N *distinct* seats, on four threads, with the target's
 * projection falling behind as it goes.
 *
 * The distinct-seat claim is what makes this the ordinal test: shards that restarted numbering
 * would send four buyers to `seat-0`, and the target would answer three of them 409. It cannot be
 * faked, because the referee counts the seats.
 */
export const hotShowManySeats = async (): Promise<void> => {
  section(
    `RUN 7 — contract runs 2 & 4: ${String(BUYERS)} buyers, ${String(BUYERS)} distinct seats, 4 threads`,
  );
  const target = await startTarget(["--port", "5999", "--delay", "2", "--projection-rate", "4"]);
  try {
    const outcome = await runPool({
      modulePath: fileURLToPath(new URL("seats-scenario.ts", import.meta.url)),
      workerCount: 4,
      maxInFlight: 400,
      drainTimeoutMs: 5_000,
      snapshotIntervalMs: 250,
      setupState: { url: TARGET_URL },
    });

    const summary = outcome.summary.scenarios[0];
    if (summary === undefined) {
      throw new Error("the pooled seat run reported no scenario");
    }
    const stats = await readTargetStats();
    const created = summary.checks.created;
    const behind = summary.trends.behindMs;

    row(
      "buyers / answered",
      `${String(summary.dispatchedCount)} / ${String(summary.responseCount)}`,
    );
    row("201s counted by stampede", String(summary.counters.reserved201 ?? 0));
    row("seats the target says it sold", String(stats.sold));
    row(
      "check created",
      `${String(created?.passed ?? 0)} pass · ${String(created?.failed ?? 0)} fail · ${String(created?.broken ?? 0)} broken`,
    );
    row(
      "projection lag — p50 / p99 / max",
      `${ms(behind?.p50Ms)} / ${ms(behind?.p99Ms)} / ${ms(behind?.maxMs)}`,
    );
    row("target's own max behind", `${String(stats.maxBehindMs)}ms`);
    process.stdout.write("\n");

    claim(
      "every buyer got a seat of their own",
      created?.failed === 0 && created.passed === BUYERS,
      `${String(created?.passed ?? 0)} of ${String(BUYERS)} created, 0 conflicts`,
    );
    claim(
      "the target sold one seat per buyer, no collisions",
      stats.sold === BUYERS,
      `${String(stats.sold)} distinct seats sold`,
    );
    claim(
      "the counter survived the merge across four threads",
      (summary.counters.reserved201 ?? 0) === BUYERS,
      `reserved201 = ${String(summary.counters.reserved201 ?? 0)}`,
    );
    // Contract run 4's number: a lag the user's own `onResponse` recorded, checked against the lag
    // the projection really had. A trend that merged wrongly across threads would miss the peak.
    claim(
      "the recorded projection lag matches the target's own peak",
      behind !== undefined &&
        behind.maxMs > 50 &&
        Math.abs(behind.maxMs - stats.maxBehindMs) <= LAG_TOLERANCE_MS,
      `${ms(behind?.maxMs)} recorded vs ${String(stats.maxBehindMs)}ms the target measured itself`,
    );
  } finally {
    target.kill();
    await sleep(250);
  }
};

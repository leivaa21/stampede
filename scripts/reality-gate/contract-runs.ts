import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { burst, httpTransport, runDispatch, systemClock } from "../../src/engine/index.ts";
import type { HttpRequestSpec } from "../../src/engine/http-transport.ts";
import { runPool } from "../../src/engine/worker-pool.ts";
import { claim, ms, readTargetStats, row, section, startTarget, TARGET_URL } from "./harness.ts";
import { BUYERS, WORKER_COUNT } from "./seats-scenario.ts";

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
 * Both sides now measure the *same instants*: the target latches its peak when it accepts a sale,
 * and stampede records the value that sale's response carried. So the only legitimate difference
 * is the histogram rounding a sample up to its bucket top — under 0.1%, which is well under a
 * millisecond at these magnitudes.
 *
 * It used to be 60ms, justified as "one tick of slack". That was the wrong mechanism: the target's
 * free-running peak kept climbing after the load stopped, so the budget was really covering the
 * gap between `runPool` resolving and the gate getting around to reading `/__stats` — a race that
 * consumed 63% of it under CPU load and would have failed a *correct* tool on a slower box.
 */
/**
 * Relative, because the error it budgets for is relative: a histogram reports the top of the
 * sample's bucket, which is under 0.1% high — 512µs of slack at 460ms but 4096µs once a peak
 * passes ~4.19s. A flat 3ms silently encoded "peaks stay under four seconds" and would have failed
 * a correct tool the first time one did not.
 */
const lagToleranceMs = (recordedMs: number): number => recordedMs / 1024 + 1;

/**
 * The lag the run has to actually produce before the agreement above means anything.
 *
 * Both sides of that comparison now derive from the same `behindMs` the target emitted, which is
 * what makes them comparable — and also what makes them jointly satisfiable by a target that
 * reports a constant, or a near-zero. Contract run 4 exists to measure a projection that *fell
 * behind*; without this floor the run could pass having measured a projection that kept up.
 */
const MIN_REAL_LAG_MS = 100;

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
    // `sold` is a `Set`, so on its own it only says "at least one 201" — it cannot tell one sale
    // from five, and the exactly-one property would rest entirely on stampede's own counter.
    // `salesIssued` and `conflicts` are the tallies that make this independent evidence, and
    // together they state open-ticket's contract literally: one winner, N−1 conflicts.
    claim(
      "the target issued exactly one sale, and N−1 conflicts",
      stats.salesIssued === 1 && stats.conflicts === BUYERS_ON_ONE_SEAT - 1,
      `${String(stats.salesIssued)} sold + ${String(stats.conflicts)} conflicts, counted by the target itself`,
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
      workerCount: WORKER_COUNT,
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
    row("lag samples merged / expected", `${String(behind?.count ?? 0)} / ${String(BUYERS)}`);
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
    // *The* claim about the merge, and the one the peak comparison below cannot make on its own.
    // Shards interleave by stride, so every worker holds samples spread across the whole run:
    // losing a worker's entire trend barely moves the max. Discarding one worker's samples left
    // the old peak claim passing at 150/200 samples; discarding three left it passing at 50/200.
    // The count is what proves nothing was lost crossing the thread boundary.
    claim(
      "every recorded lag sample survived the merge across four threads",
      behind?.count === BUYERS,
      `${String(behind?.count ?? 0)} of ${String(BUYERS)} samples`,
    );
    // Contract run 4's number: a lag the config recorded through `onResponse`, checked against the
    // peak the projection latched at the same instants. Directional, because the two errors are not
    // symmetric — under-reporting means the merge lost the peak, over-reporting means stampede
    // invented lag the target never had. Only the histogram's round-up-to-bucket-top is allowed.
    claim(
      "the projection really did fall behind, so there was a lag to measure",
      stats.maxBehindMs > MIN_REAL_LAG_MS,
      `${String(stats.maxBehindMs)}ms peak, against a ${String(MIN_REAL_LAG_MS)}ms floor`,
    );
    claim(
      "the recorded projection lag matches the target's own peak",
      behind !== undefined &&
        behind.maxMs >= stats.maxBehindMs &&
        behind.maxMs - stats.maxBehindMs <= lagToleranceMs(behind.maxMs),
      `${ms(behind?.maxMs)} recorded vs ${String(stats.maxBehindMs)}ms the target measured itself`,
    );
    // Run 6 asserts these; run 7 must too, or half the trend could vanish into broken observations
    // while `reserved201` stayed at 200 and every other claim held.
    // Otherwise every claim in this run holds with one worker, while its title says four.
    const threads = Object.keys(summary.counters).filter((name) => name.startsWith("thread-"));
    // Summed, not divided: `BUYERS` is read off the profile precisely so the gate never asserts
    // against a number the profile did not produce, and `BUYERS / WORKER_COUNT` puts that coupling
    // straight back — a rate of 90/s would fail this on a correct tool, for arithmetic reasons.
    const perThread = threads.map((name) => summary.counters[name] ?? 0);
    claim(
      "the schedule really was split across four threads",
      threads.length === WORKER_COUNT &&
        perThread.every((count) => count > 0) &&
        perThread.reduce((a, b) => a + b, 0) === BUYERS,
      `${String(threads.length)} threads, ${perThread.join("/")} responses each`,
    );
    claim(
      "no claim was broken and no recording refused",
      summary.brokenObservations === 0 && summary.refusedRecordings === 0,
      `${String(summary.brokenObservations)} broken, ${String(summary.refusedRecordings)} refused`,
    );
  } finally {
    target.kill();
    await sleep(250);
  }
};

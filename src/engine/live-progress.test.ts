import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCountingServer, type CountingServer } from "../test-support/counting-server.ts";
import type { RunSummary } from "./run-summary.ts";
import { parseWorkerMessage } from "./worker-protocol.ts";
import { runPool } from "./worker-pool.ts";

/**
 * The live-progress protocol — the reason PR 8 exists.
 *
 * PR 4 shipped without a live callback because the obvious one merged metrics from *every* worker
 * with progress from only the *finished* ones, and published a run whose dispatched count exceeded
 * its scheduled count. The fix was to put progress on every message. None of that was pinned by a
 * test, so the fix could be reverted verbatim with the whole suite green — which is what this file
 * is for.
 */

const FIXTURE = fileURLToPath(new URL("../test-support/worker-fixture.ts", import.meta.url));

let target: CountingServer;

beforeEach(async () => {
  target = await startCountingServer();
});

afterEach(async () => {
  await target.close();
});

describe("live progress from a pooled run", () => {
  it("never reports more dispatched than scheduled, on any frame", async () => {
    const frames: RunSummary[] = [];

    await runPool({
      modulePath: FIXTURE,
      workerCount: 3,
      maxInFlight: 64,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 20,
      setupState: { kind: "rate", count: 90, durationMs: 600, url: target.url },
      onProgress: (summary) => frames.push(summary),
    });

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      for (const scenario of frame.scenarios) {
        expect(scenario.dispatchedCount).toBeLessThanOrEqual(scenario.scheduledCount);
        expect(scenario.responseCount).toBeLessThanOrEqual(scenario.dispatchedCount);
      }
    }
  }, 30_000);

  it("reports the whole run's schedule from the very first frame", async () => {
    // Merged progress is a union over the workers heard from, so an early frame used to state a
    // fraction of the schedule and a fraction of the requested rate — and the progress bar went
    // backwards as later workers arrived. Nothing is published until every worker has reported.
    const frames: RunSummary[] = [];

    await runPool({
      modulePath: FIXTURE,
      workerCount: 4,
      maxInFlight: 64,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 20,
      setupState: { kind: "rate", count: 120, durationMs: 600, url: target.url },
      onProgress: (summary) => frames.push(summary),
    });

    for (const frame of frames) {
      expect(frame.scenarios[0]?.scheduledCount).toBe(72);
    }
  }, 30_000);

  it("never lets the progress bar go backwards", async () => {
    const done: number[] = [];

    await runPool({
      modulePath: FIXTURE,
      workerCount: 3,
      maxInFlight: 64,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 20,
      setupState: { kind: "rate", count: 90, durationMs: 600, url: target.url },
      onProgress: (summary) => {
        const scenario = summary.scenarios[0];
        if (scenario !== undefined) {
          done.push(scenario.dispatchedCount + scenario.droppedCount);
        }
      },
    });

    for (const [index, value] of done.entries()) {
      expect(value).toBeGreaterThanOrEqual(done[index - 1] ?? 0);
    }
  }, 30_000);

  it("finishes the run even when the live consumer throws every frame", async () => {
    // A render bug on frame three must not abort a load test — the argument `in-flight.ts` makes by
    // name. The run is the product; the live view is a convenience.
    const outcome = await runPool({
      modulePath: FIXTURE,
      workerCount: 2,
      maxInFlight: 64,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 20,
      setupState: { kind: "rate", count: 60, durationMs: 400, url: target.url },
      onProgress: () => {
        throw new Error("a render bug");
      },
    });

    expect(outcome.summary.scenarios[0]?.dispatchedCount).toBe(24);
  }, 30_000);
});

describe("checks and counters across real threads", () => {
  it("merges check tallies from every worker into one run's claim", async () => {
    // The claim "exactly one 201 among 500 racers" is about a *run*, and a run is spread over
    // threads. metrics/ proves the merge in isolation; this proves it through the user-facing path.
    const outcome = await runPool({
      modulePath: FIXTURE,
      workerCount: 4,
      // Above the burst size deliberately: a check only runs on a *response*, so a run that drops
      // requests would report fewer checks than requests and the test would be measuring the cap.
      maxInFlight: 200,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 25,
      setupState: { kind: "burst", count: 80, url: target.url, withChecks: true },
    });

    const reads = outcome.summary.scenarios[0];
    expect(reads?.checks.alwaysPasses).toEqual({ passed: 80, failed: 0, broken: 0 });
    expect(reads?.checks.alwaysFails).toEqual({ passed: 0, failed: 80, broken: 0 });
    // A throwing check is broken, not failed — and the per-name tally survives the worker merge,
    // so the report can name the broken claim instead of accusing the target of a failure.
    expect(reads?.checks.alwaysThrows).toEqual({ passed: 0, failed: 0, broken: 80 });
    expect(reads?.brokenObservations).toBe(80);
  }, 30_000);

  it("merges a declared keyed counter across four threads, `other` included", async () => {
    // D1-02's property, asserted for the new metric kind rather than assumed. A keyed counter is a
    // reservation pattern over the same map, so if the merge were anything other than elementwise
    // addition this is where four shards would disagree with one.
    const outcome = await runPool({
      modulePath: FIXTURE,
      workerCount: 4,
      maxInFlight: 300,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 25,
      setupState: { kind: "burst", count: 120, url: target.url, withKeyedCounter: true },
    });

    const reads = outcome.summary.scenarios[0];

    // Absolutes from the config, not `responseCount` — that is itself merged by the same
    // `Counters.merge`, so a merge of `Math.max` would leave both sides agreeing at one shard's
    // numbers and this claim green. 120 in a burst over 4 shards is 30 each, alternating from 1.
    // The undeclared key really lands in `other` rather than creating a name of its own, which is
    // the bound the whole feature exists to provide.
    expect(reads?.keyedCounters.byOutcome).toEqual({ declared: 60, other: 60 });
    // And it is reported *only* nested — a slot listed in both maps could be added into a total
    // twice by a reader who trusted either one.
    expect(reads?.counters).toEqual({});
  }, 30_000);

  it("merges a user counter to exactly the response count", async () => {
    const outcome = await runPool({
      modulePath: FIXTURE,
      workerCount: 4,
      maxInFlight: 300,
      drainTimeoutMs: 2_000,
      snapshotIntervalMs: 25,
      setupState: { kind: "burst", count: 120, url: target.url, withCounter: true },
    });

    const reads = outcome.summary.scenarios[0];
    expect(reads?.counters.seen).toBe(120);
    expect(reads?.responseCount).toBe(120);
    // The engine's own metrics stay off the user's map — a rename inside the engine must not
    // silently change what a user's threshold reads.
    expect(Object.keys(reads?.counters ?? {})).toEqual(["seen"]);
  }, 30_000);
});

describe("parseWorkerMessage", () => {
  const snapshot = { scenarios: new Map(), sequence: 1 };
  const progress = { elapsedMs: 10, maxObservedInFlight: 2, scenarios: [] };

  it("accepts a snapshot that carries its sender's progress", () => {
    const message = parseWorkerMessage({ kind: "snapshot", snapshot, progress });

    expect(message.kind).toBe("snapshot");
    expect(message.kind === "snapshot" && message.progress.elapsedMs).toBe(10);
  });

  it("refuses a snapshot without progress, rather than merging a partial view", () => {
    // The whole protocol change. Without progress on every message the aggregate holds metrics
    // from all workers and progress from the finished ones alone.
    expect(() => parseWorkerMessage({ kind: "snapshot", snapshot })).toThrow(
      /snapshot message must carry run progress/,
    );
  });

  it("refuses a finished message without progress", () => {
    expect(() => parseWorkerMessage({ kind: "finished", snapshot })).toThrow(
      /finished message must carry run progress/,
    );
  });
});

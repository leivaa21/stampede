import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCountingServer, type CountingServer } from "../test-support/counting-server.ts";
import { runPool } from "./worker-pool.ts";

/**
 * The property contract run 2 depends on: every buyer gets a *different* seat.
 *
 * `mergedSchedule` numbers dispatches from 0 within whatever it is given, so four workers each
 * numbering from 0 would build request 0 four times — and "500 buyers, 500 distinct seats" would
 * quietly become four buyers per seat, which is the exact bug the run exists to detect. The stride
 * split *is* the mapping `shardIndex + localOrdinal * shardCount`, and this proves the recovery.
 *
 * Asserted against the **target's own record** of what it was asked for, not against stampede's
 * accounting — a bug in the ordinal would be invisible to a tool checking its own arithmetic.
 */

const FIXTURE = fileURLToPath(new URL("../test-support/worker-fixture.ts", import.meta.url));

let target: CountingServer;

beforeEach(async () => {
  target = await startCountingServer();
});

afterEach(async () => {
  await target.close();
});

const ordinalsSeenBy = (paths: readonly string[]): number[] =>
  paths
    .map((path) => /\/seat-(\d+)$/.exec(path)?.[1])
    .filter((seat): seat is string => seat !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

describe("the dispatch ordinal is global to the run", () => {
  it("uses every ordinal exactly once across four workers", async () => {
    await runPool({
      modulePath: FIXTURE,
      workerCount: 4,
      maxInFlight: 400,
      drainTimeoutMs: 3_000,
      snapshotIntervalMs: 25,
      setupState: { kind: "burst", count: 120, url: target.url, varyByOrdinal: true },
    });

    const seen = ordinalsSeenBy(target.paths());

    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual(Array.from({ length: 120 }, (_unused, index) => index));
  }, 30_000);

  it("is unchanged on a single worker", async () => {
    await runPool({
      modulePath: FIXTURE,
      workerCount: 1,
      maxInFlight: 100,
      drainTimeoutMs: 3_000,
      snapshotIntervalMs: 25,
      setupState: { kind: "burst", count: 30, url: target.url, varyByOrdinal: true },
    });

    expect(ordinalsSeenBy(target.paths())).toEqual(
      Array.from({ length: 30 }, (_unused, index) => index),
    );
  }, 30_000);

  it("gives a worker count that does not divide the run no repeats either", async () => {
    // 100 over 3 shards: the stride leaves uneven slices, and the union must still be exact.
    await runPool({
      modulePath: FIXTURE,
      workerCount: 3,
      maxInFlight: 300,
      drainTimeoutMs: 3_000,
      snapshotIntervalMs: 25,
      setupState: { kind: "burst", count: 100, url: target.url, varyByOrdinal: true },
    });

    const seen = ordinalsSeenBy(target.paths());

    expect(new Set(seen).size).toBe(100);
    expect(Math.max(...seen)).toBe(99);
  }, 30_000);
});

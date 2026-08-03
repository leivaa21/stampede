import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * The parts every gate run shares: the reference target, the tally, and the way a claim is printed.
 *
 * Split out of `run.ts` when the gate outgrew one file. The failure count lives here rather than in
 * the runner because it is what the exit code is made of, and a run that could forget to report a
 * failure would turn the whole gate into decoration.
 */

export const TARGET_PORT = 5999;
export const TARGET_URL = `http://localhost:${String(TARGET_PORT)}/`;

export interface TargetStats {
  /** The answering process. Guards against grading a run against a stale target — see `startTarget`. */
  readonly pid: number;
  readonly received: number;
  readonly completed: number;
  readonly achievedRps: number;
  /** Distinct seats the target really sold — the referee for the contract runs. */
  readonly sold: number;
  /** 201s actually issued. `sold` is a Set, so only this can tell one sale from five. */
  readonly salesIssued: number;
  readonly conflicts: number;
  /** Peak lag at the instants sales were accepted. Stops moving when the load stops. */
  readonly maxBehindMs: number;
}

export const readTargetStats = async (): Promise<TargetStats> => {
  const response = await fetch(`${TARGET_URL}__stats`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new TypeError("the target returned a malformed stats body");
  }
  const { pid, received, completed, achievedRps, sold, salesIssued, conflicts, maxBehindMs } =
    body as Record<string, unknown>;
  if (
    typeof pid !== "number" ||
    typeof received !== "number" ||
    typeof completed !== "number" ||
    typeof achievedRps !== "number" ||
    typeof sold !== "number" ||
    typeof salesIssued !== "number" ||
    typeof conflicts !== "number" ||
    typeof maxBehindMs !== "number"
  ) {
    throw new TypeError("the target's stats are missing a count");
  }
  return { pid, received, completed, achievedRps, sold, salesIssued, conflicts, maxBehindMs };
};

/**
 * Spawns the reference target and **waits for it to answer**, rather than sleeping and hoping.
 *
 * A fixed sleep turns "the target failed to start" into an ECONNREFUSED storm from the first run
 * that touches it — which is what a parameter property in the projection model produced: a wall of
 * connect errors and a stack trace pointing at the dispatcher, for a syntax error two files away.
 * Polling costs nothing when the target is healthy and names the real problem when it is not.
 */
/**
 * The port is held by a target this run did not start.
 *
 * A class rather than a string match: the readiness loop retries connection failures and rethrows
 * everything else, and telling those apart by `message.includes(...)` is a sentinel one rename
 * away from being silently retried until the deadline.
 */
export class StaleTargetError extends Error {}

const staleTarget = (pid: number): StaleTargetError =>
  new StaleTargetError(
    `port ${String(TARGET_PORT)} is held by a stale reality-gate target (pid ${String(pid)}); kill it and re-run`,
  );

export const startTarget = async (args: readonly string[]): Promise<ChildProcess> => {
  // Checked *before* spawning, because our child loses this race: it dies of EADDRINUSE within
  // milliseconds, so a post-spawn poll reports "exited with code 1" — the symptom — while the
  // cause is a target a previous run left behind. One request, and the diagnosis is exact.
  const squatter = await fetch(`${TARGET_URL}__stats`).catch(() => undefined);
  if (squatter !== undefined) {
    const body: unknown = await squatter.json().catch(() => undefined);
    const pid =
      typeof body === "object" && body !== null
        ? (body as { readonly pid?: unknown }).pid
        : undefined;
    throw staleTarget(typeof pid === "number" ? pid : 0);
  }

  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("target-server.ts", import.meta.url)), ...args],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const deadline = 10_000;
  let stalePid: number | undefined;
  for (let waited = 0; waited < deadline; waited += 50) {
    if (server.exitCode !== null) {
      throw new Error(
        `the reality-gate target exited with code ${String(server.exitCode)} before it could listen`,
      );
    }
    try {
      const stats = await readTargetStats();
      // The port answering is not the same as *our* target answering. A previous run killed
      // uncleanly leaves its server bound, the first poll succeeds before our child has had time
      // to fail on EADDRINUSE, and the gate goes green against a server it never configured —
      // measured at 7/7 PASS with a projection 8× faster than the one the run asked for.
      //
      // Recorded and retried rather than thrown on sight: a *dying* predecessor answers for a few
      // milliseconds too, and turning that transient into "kill it and re-run" would be its own
      // false diagnosis. If it is still there at the deadline, it is not dying.
      if (stats.pid !== server.pid) {
        stalePid = stats.pid;
        await sleep(50);
        continue;
      }
      return server;
    } catch (error: unknown) {
      // Only a connection failure means "not up yet". A malformed stats body means the target is
      // answering and the *contract* is wrong — retrying that for ten seconds and then reporting
      // "did not answer" is the misdiagnosis this loop exists to prevent.
      if (!(error instanceof TypeError)) {
        server.kill();
        throw error;
      }
      await sleep(50);
    }
  }
  server.kill();
  if (stalePid !== undefined) {
    throw staleTarget(stalePid);
  }
  throw new Error(`the reality-gate target did not answer within ${String(deadline)}ms`);
};

let failures = 0;

export const failureCount = (): number => failures;

export const ms = (value: number | undefined): string =>
  value === undefined ? "n/a" : `${value.toFixed(1)}ms`;

export const row = (label: string, value: string): void => {
  process.stdout.write(`    ${label.padEnd(42)}${value}\n`);
};

export const section = (title: string): void => {
  process.stdout.write(`\n${"─".repeat(76)}\n${title}\n${"─".repeat(76)}\n`);
};

export const claim = (label: string, holds: boolean, detail: string): void => {
  if (!holds) {
    failures += 1;
  }
  process.stdout.write(`    ${holds ? "PASS" : "FAIL"}  ${label} — ${detail}\n`);
};

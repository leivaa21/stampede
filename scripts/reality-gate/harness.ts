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
  const { received, completed, achievedRps, sold, salesIssued, conflicts, maxBehindMs } =
    body as Record<string, unknown>;
  if (
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
  return { received, completed, achievedRps, sold, salesIssued, conflicts, maxBehindMs };
};

/**
 * Spawns the reference target and **waits for it to answer**, rather than sleeping and hoping.
 *
 * A fixed sleep turns "the target failed to start" into an ECONNREFUSED storm from the first run
 * that touches it — which is what a parameter property in the projection model produced: a wall of
 * connect errors and a stack trace pointing at the dispatcher, for a syntax error two files away.
 * Polling costs nothing when the target is healthy and names the real problem when it is not.
 */
export const startTarget = async (args: readonly string[]): Promise<ChildProcess> => {
  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("target-server.ts", import.meta.url)), ...args],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const deadline = 10_000;
  for (let waited = 0; waited < deadline; waited += 50) {
    if (server.exitCode !== null) {
      throw new Error(
        `the reality-gate target exited with code ${String(server.exitCode)} before it could listen`,
      );
    }
    try {
      await fetch(`${TARGET_URL}__stats`);
      return server;
    } catch {
      await sleep(50);
    }
  }
  server.kill();
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

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
/**
 * `127.0.0.1`, not `localhost`, because that is the interface `target-server.ts` binds.
 *
 * On a host resolving `localhost` to `::1` only, the gate could never reach its own target — and
 * on a dual-stack host the refusal arrives as an `AggregateError` whose `code` is taken from the
 * *first* address family, which made "is this a refused connection?" depend on resolution order.
 */
export const TARGET_URL = `http://127.0.0.1:${String(TARGET_PORT)}/`;

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

/**
 * Bounded, because undici's default header timeout is five minutes.
 *
 * A socket that accepts and never writes — a target stopped in a debugger, a non-HTTP listener —
 * left `pnpm gate:two` sitting under a printed run header in silence, which is the failure
 * mode this harness exists to name rather than produce.
 */
const STATS_TIMEOUT_MS = 2_000;

export const readTargetStats = async (): Promise<TargetStats> => {
  const response = await fetch(`${TARGET_URL}__stats`, {
    signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new MalformedStatsError("the target returned a malformed stats body");
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
    throw new MalformedStatsError(
      "the target's stats are missing a count — the gate and the target disagree about the contract",
    );
  }
  return { pid, received, completed, achievedRps, sold, salesIssued, conflicts, maxBehindMs };
};

/**
 * The port is held by a target this run did not start.
 *
 * A class rather than a string match: the readiness loop retries connection failures and rethrows
 * everything else, and telling those apart by `message.includes(...)` is a sentinel one rename
 * away from being silently retried until the deadline.
 */
export class StaleTargetError extends Error {}

/**
 * The target answered and its stats did not match the shape the gate reads.
 *
 * Its own class because `undici` rejects `fetch` with a plain `TypeError` on a refused connection,
 * so "is this a `TypeError`?" cannot tell "not up yet" from "the contract drifted" — which put the
 * second case on the retry path and turned a renamed field into ten seconds of stalling followed by
 * "the target did not answer", the exact misdiagnosis the polling loop exists to prevent.
 */
export class MalformedStatsError extends Error {}

/**
 * `undici` rejects a refused connection with a plain `TypeError` whose cause carries the code, so
 * the class alone cannot tell "nothing is listening yet" from "our reading of the stats is wrong".
 *
 * The `AggregateError` branch is **unreachable while `TARGET_URL` is a literal address**, and kept
 * so the predicate survives that becoming a name again: a name resolving to several addresses
 * produces a cause whose `code` is copied from the *first* member only, so a host where `::1` fails
 * with `ENETUNREACH` while IPv4 refuses would not match on `code` alone.
 *
 * A cause-less `TypeError` is deliberately **not** retried: Node always attaches one to a network
 * failure, so a bare one is a programming error inside `readTargetStats` — exactly the "the target
 * answered and our reading is wrong" case this predicate exists to fail fast on.
 */
const isConnectionRefused = (error: unknown): boolean => {
  if (!(error instanceof TypeError) || error.cause === undefined) {
    return false;
  }
  const cause = error.cause as { readonly code?: unknown; readonly errors?: unknown };
  if (cause.code === "ECONNREFUSED") {
    return true;
  }
  return (
    Array.isArray(cause.errors) &&
    cause.errors.length > 0 &&
    cause.errors.every(
      (member: unknown) => (member as { readonly code?: unknown }).code === "ECONNREFUSED",
    )
  );
};

const staleTarget = (pid: number): StaleTargetError =>
  new StaleTargetError(
    `port ${String(TARGET_PORT)} is held by a stale reality-gate target (pid ${String(pid)}); kill it and re-run`,
  );

/**
 * Spawns the reference target and **waits for it to answer**, rather than sleeping and hoping.
 *
 * A fixed sleep turns "the target failed to start" into an ECONNREFUSED storm from the first run
 * that touches it — which is what a parameter property in the projection model produced: a wall of
 * connect errors and a stack trace pointing at the dispatcher, for a syntax error two files away.
 * Polling costs nothing when the target is healthy and names the real problem when it is not.
 */
export const startTarget = async (args: readonly string[]): Promise<ChildProcess> => {
  // Checked *before* spawning, because our child loses this race: it dies of EADDRINUSE within
  // milliseconds, so a post-spawn poll reports "exited with code 1" — the symptom — while the
  // cause is a target a previous run left behind. One request, and the diagnosis is exact.
  const squatter = await fetch(`${TARGET_URL}__stats`, {
    signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
  }).catch((error: unknown) => {
    // Timed out rather than refused: something owns the port and is not answering, which is its
    // own diagnosis — and the one case where the gate would otherwise sit silent for minutes.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `something is holding port ${String(TARGET_PORT)} without answering; the gate cannot start`,
      );
    }
    return undefined;
  });
  if (squatter !== undefined) {
    const body: unknown = await squatter.json().catch(() => undefined);
    const pid =
      typeof body === "object" && body !== null
        ? (body as { readonly pid?: unknown }).pid
        : undefined;
    // A pid-less body means something that is not this gate's target owns the port. It is not
    // ours to diagnose or to kill, and calling it a stale gate target names the wrong cause — with
    // a pid of 0 — to whoever has to clear it.
    if (typeof pid !== "number") {
      throw new Error(
        `something that is not a reality-gate target is already listening on port ${String(TARGET_PORT)}`,
      );
    }
    throw staleTarget(pid);
  }

  const server = spawn(
    process.execPath,
    [fileURLToPath(new URL("target-server.ts", import.meta.url)), ...args],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const deadline = 10_000;
  for (let waited = 0; waited < deadline; waited += 50) {
    let answered: TargetStats;
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
      answered = stats;
    } catch (error: unknown) {
      // Retried only when the port refused the connection — "not up yet". Everything else means
      // the target *answered* and something is wrong with what it said, and retrying that for ten
      // seconds before reporting "did not answer" is the misdiagnosis this loop exists to prevent.
      //
      // A deny-list, not an allow-list: the previous shape retried every class it did not name,
      // so each new error type defaulted to ten seconds of silence.
      if (!isConnectionRefused(error)) {
        server.kill();
        throw error;
      }
      await sleep(50);
      continue;
    }

    // Outside the `try`, deliberately. Thrown inside it, this was caught by the `catch` below,
    // discarded, and retried to the deadline — and since `server.kill()` leaves `exitCode` null,
    // nothing else tripped either. The diagnosis regressed to "did not answer".
    if (answered.pid !== server.pid) {
      server.kill();
      throw staleTarget(answered.pid);
    }
    return server;
  }
  server.kill();
  throw new Error(`the reality-gate target did not answer within ${String(deadline)}ms`);
};

let failures = 0;
let claims = 0;

export const failureCount = (): number => failures;

/**
 * How many claims were made at all.
 *
 * `failures === 0` is the wrong thing to publish on its own: a refactor that stopped calling
 * `claim()` would turn this gate into a green light over an empty run, which is the same lie as a
 * threshold reading a counter that was never written.
 */
export const claimCount = (): number => claims;

export interface Verdict {
  readonly line: string;
  readonly exitCode: 0 | 1 | 2;
}

/**
 * The gate's whole contract in one pure function: how many claims ran, how many failed, and what
 * that means for the exit code the nightly workflow classifies on.
 *
 * Pure and exported so it can be tested as a table. `1` is a claim that did not hold; `2` is "the
 * gate could not be run", **including zero claims** — a refactor that stopped calling `claim()`
 * would otherwise turn the gate into a green light over an empty run, which is the same lie as a
 * percentile drawn from an empty histogram.
 */
export const verdict = (failures: number, total: number): Verdict => {
  if (total === 0) {
    return { line: "GATE TWO COULD NOT RUN — no claims were made", exitCode: 2 };
  }
  if (failures > 0) {
    return { line: `GATE TWO FAILED — ${String(failures)} claim(s) did not hold`, exitCode: 1 };
  }
  return {
    line: `GATE TWO PASSED — ${String(total)} claims, the numbers are true against a target that knows better`,
    exitCode: 0,
  };
};

export const ms = (value: number | undefined): string =>
  value === undefined ? "n/a" : `${value.toFixed(1)}ms`;

export const row = (label: string, value: string): void => {
  process.stdout.write(`    ${label.padEnd(42)}${value}\n`);
};

export const section = (title: string): void => {
  process.stdout.write(`\n${"─".repeat(76)}\n${title}\n${"─".repeat(76)}\n`);
};

export const claim = (label: string, holds: boolean, detail: string): void => {
  claims += 1;
  if (!holds) {
    failures += 1;
  }
  process.stdout.write(`    ${holds ? "PASS" : "FAIL"}  ${label} — ${detail}\n`);
};

import { hotShowManySeats, theStampede } from "./contract-runs.ts";
import { failureCount } from "./harness.ts";
import { workerPoolRun } from "./pool-run.ts";
import { timingRuns } from "./timing-runs.ts";

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
 * Runs 1–4 ask whether the instrument measures **time** honestly. Run 5 asks whether four threads
 * measure what one thread would have. Runs 6–7 ask the other half of the pitch: whether an
 * **invariant** survives checks, counters, a worker pool and a summary, and comes out agreeing with
 * a referee that counted independently.
 *
 * Exits non-zero if any claim fails, so it can gate a release the same way a threshold gates a run.
 */

await timingRuns();
await workerPoolRun();
await theStampede();
await hotShowManySeats();

const failures = failureCount();
process.stdout.write(`\n${"═".repeat(76)}\n`);
process.stdout.write(
  failures === 0
    ? "GATE TWO PASSED — the numbers are true against a target that knows better\n"
    : `GATE TWO FAILED — ${String(failures)} claim(s) did not hold\n`,
);
process.stdout.write(`${"═".repeat(76)}\n`);
process.exitCode = failures === 0 ? 0 : 1;

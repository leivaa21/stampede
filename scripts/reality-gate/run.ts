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
 * **The exit codes are the CLI's own contract, for the same reason.** `1` means a claim did not
 * hold — the numbers this repo publishes are no longer true. `2` means the gate could not be run at
 * all: a throw out of a run, an OOM-killed worker, a port that would not bind. Collapsing them into
 * "non-zero" is what would let the nightly workflow open an issue titled "the published numbers may
 * no longer be true" because a shared runner ran out of memory — and then, because it keeps one
 * sticky issue, pin every real failure for the next week behind that infrastructure story.
 */

try {
  await timingRuns();
  await workerPoolRun();
  await theStampede();
  await hotShowManySeats();
} catch (error: unknown) {
  process.stderr.write(
    `\n${"═".repeat(76)}\nGATE TWO COULD NOT RUN — this is not a failed claim\n${"═".repeat(76)}\n`,
  );
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(2);
}

const failures = failureCount();
process.stdout.write(`\n${"═".repeat(76)}\n`);
process.stdout.write(
  failures === 0
    ? "GATE TWO PASSED — the numbers are true against a target that knows better\n"
    : `GATE TWO FAILED — ${String(failures)} claim(s) did not hold\n`,
);
process.stdout.write(`${"═".repeat(76)}\n`);
process.exitCode = failures === 0 ? 0 : 1;

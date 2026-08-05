import { hotShowManySeats, theStampede } from "./contract-runs.ts";
import { claimCount, failureCount } from "./harness.ts";
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

const LINE = "═".repeat(76);

const couldNotRun = (reason: string, error: unknown): void => {
  const failures = failureCount();
  process.stderr.write(`\n${LINE}\nGATE TWO COULD NOT RUN — ${reason}\n${LINE}\n`);
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  // A claim that already failed outranks the crash. Exit 2 says "no evidence about the published
  // numbers either way", and that is false the moment something has been shown not to hold —
  // reporting it as 2 would let the nightly stay silent about a real regression.
  //
  // The verdict line is written here too, and to stderr, for two reasons: the nightly classifies
  // on this exact string rather than on the exit code alone, and stdout may still be queued on a
  // pipe that `process.exit` is about to discard.
  if (failures > 0) {
    process.stderr.write(
      `${LINE}\nGATE TWO FAILED — ${String(failures)} claim(s) did not hold before the crash\n${LINE}\n`,
    );
  }
  process.exit(failures > 0 ? 1 : 2);
};

// The four awaits below are not the only way this process can exit non-zero, and the docblock's
// contract has to hold for the others too — `src/cli.ts` installs the same two handlers for exactly
// this reason. `harness.ts` spawns the target without an `"error"` listener, so a fork that fails
// under memory pressure (the case the contract is *about*) surfaces here rather than at an await.
process.on("uncaughtException", (error: unknown) => {
  couldNotRun("an uncaught exception, not a failed claim", error);
});
process.on("unhandledRejection", (error: unknown) => {
  couldNotRun("an unhandled rejection, not a failed claim", error);
});

try {
  await timingRuns();
  await workerPoolRun();
  await theStampede();
  await hotShowManySeats();
} catch (error: unknown) {
  couldNotRun("this is not a failed claim", error);
}

const failures = failureCount();
const total = claimCount();
process.stdout.write(`\n${LINE}\n`);
if (total === 0) {
  // Not a pass. Zero claims is a gate that measured nothing, and publishing "PASSED" for it is the
  // same lie as a percentile drawn from an empty histogram.
  process.stdout.write("GATE TWO COULD NOT RUN — no claims were made\n");
} else {
  process.stdout.write(
    failures === 0
      ? `GATE TWO PASSED — ${String(total)} claims, the numbers are true against a target that knows better\n`
      : `GATE TWO FAILED — ${String(failures)} claim(s) did not hold\n`,
  );
}
process.stdout.write(`${LINE}\n`);
// `exitCode` rather than `process.exit`, which drops whatever is still queued on a pipe — and this
// script writes a lot to one. Nothing holds the loop open: every run kills its target in a
// `finally`.
process.exitCode = total === 0 ? 2 : failures === 0 ? 0 : 1;

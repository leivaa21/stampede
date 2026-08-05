import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HELP, parseArgs } from "./cli/args.ts";
import { renderSummary, renderVerdict } from "./cli/render.ts";
import { plain } from "./report/format.ts";
import { ExitCode, runFromConfig, type ExitCodeValue } from "./cli/run-command.ts";
import { guardTerminal } from "./cli/signals.ts";
import { renderMarkdownReport } from "./report/markdown.ts";
import { createDashboard } from "./tui/dashboard.ts";
import { readVersion } from "./version.ts";

/**
 * The command line.
 *
 * The only file in the repo that decides a process exit code, and the codes are a contract: CI has
 * to be able to tell "your system broke an invariant" (1) from "the tool could not run" (2). A
 * broken install reporting as a failed threshold would send someone hunting a race condition that
 * was never there.
 */

const out = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};
const err = (text: string): void => {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
};

/** Set while a dashboard is drawing, so the stray-failure handlers can put the terminal back. */
let restoreTerminal: (() => void) | undefined;

const run = async (argv: readonly string[]): Promise<ExitCodeValue> => {
  const args = parseArgs(argv);
  const version = readVersion(new URL("../package.json", import.meta.url));

  if (args.kind === "help") {
    out(HELP);
    return ExitCode.Ok;
  }
  if (args.kind === "version") {
    out(version);
    return ExitCode.Ok;
  }
  if (args.kind === "error") {
    err(`stampede: ${plain(args.message)}`);
    err("");
    err(HELP);
    return ExitCode.RunFailed;
  }

  // A dashboard only where there is a terminal to draw on. Piped into a file or a CI log, the
  // cursor moves would be literal escape codes in the artefact — so the same run that draws live
  // for a human prints nothing extra for a machine, and `--ci` forces the machine's view.
  const interactive = !args.ci && process.stdout.isTTY;
  const dashboard = interactive
    ? createDashboard({
        write: (text) => process.stdout.write(text),
        columns: process.stdout.columns,
      })
    : undefined;

  // Ctrl-C is the *normal* way to end a long load test, and the dashboard hides the cursor when it
  // starts. Without this the user's shell is left with an invisible cursor after the run they
  // interrupted — a tool damaging the terminal on its most common exit.
  restoreTerminal = () => {
    dashboard?.stop();
  };
  const guard = guardTerminal(restoreTerminal, {
    once: (signal, handler) => process.once(signal, handler),
    off: (signal, handler) => process.off(signal, handler),
    exit: (code) => process.exit(code),
  });

  let report;
  try {
    report = await runFromConfig({
      configPath: args.configPath,
      workers: args.workers,
      onProgress:
        dashboard === undefined
          ? undefined
          : (summary) => {
              dashboard.update(summary);
            },
    });
  } finally {
    // Cleared before anything else prints, so the final summary never lands under a stale frame —
    // and in a `finally`, so a throw does not leave the frame and the hidden cursor behind.
    dashboard?.stop();
    restoreTerminal = undefined;
    guard.release();
  }

  // Written whenever there is something to report, including on a *failed* run: a report showing
  // which threshold broke is exactly what someone needs after a red CI job, and withholding it
  // because the run failed would withhold it precisely when it matters.
  if (args.reportPath !== undefined && report.summary === undefined) {
    // Silence here is dangerous: a CI job that uploads out.md as an artifact would publish the
    // previous run's numbers as this run's.
    err(
      `stampede: no report written to ${plain(args.reportPath)} — the run produced no measurements`,
    );
  }
  if (args.reportPath !== undefined && report.summary !== undefined) {
    try {
      const target = path.resolve(args.reportPath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        renderMarkdownReport(report.summary, report.verdict, {
          version,
          // The raw string the user typed, not the resolved one: it is short, it is what they
          // wrote, and it keeps an absolute home directory out of a file bound for a public README.
          configPath: args.configPath,
          workerCount: report.workerCount,
          maxInFlight: report.maxInFlight,
          drainTimeoutMs: report.drainTimeoutMs,
          failures: report.failures,
          supersededSnapshots: report.supersededSnapshots,
          generatedAt: new Date(),
        }),
      );
      out(`report written to ${plain(target)}`);
    } catch (error: unknown) {
      // A report that could not be written must not turn a passing run into a failing one, but it
      // must not pass silently either — someone asked for it and is going to go looking.
      err(
        `stampede: could not write the report: ${plain(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  if (report.summary !== undefined) {
    out(renderSummary(report.summary));
  }
  if (report.supersededSnapshots > 0) {
    // Expected to be zero; non-zero means the worker protocol's ordering assumption stopped
    // holding, which is worth knowing before it becomes a wrong published number.
    err(
      `note: ${String(report.supersededSnapshots)} worker snapshots arrived out of order and were discarded`,
    );
  }
  // `renderVerdict` is empty when a failed run declared no thresholds — printing it would add a
  // stray blank line between the summary and the reasons.
  const verdictText =
    report.verdict === undefined ? "" : renderVerdict(report.verdict, report.failures.length > 0);
  if (verdictText.length > 0) {
    out(verdictText);
  }
  // One prefixed line per reason. Joined into a single string they lost their `stampede: ` prefix
  // from the second reason on, so three of four reasons read as stray output in a CI log.
  for (const failure of report.failures) {
    err(`stampede: ${plain(failure)}`);
  }

  // Only when something was actually violated. Thresholds are now evaluated even after a teardown
  // failure — so a run that failed *only* in teardown has a defined verdict with nothing in it,
  // and "0 threshold(s) violated" would be a line that says nothing while looking like it does.
  if (report.verdict !== undefined && report.verdict.violated.length > 0) {
    err(`stampede: ${String(report.verdict.violated.length)} threshold(s) violated`);
  }
  return report.exitCode;
};

/**
 * **Every writer of free text in this file goes through `plain`, with no exception.** Most carry
 * only the operator's own argv or a resolved path — self-inflicted rather than target-controlled —
 * and each could be argued out of individually. The point is that the argument does not have to be
 * made: a reader auditing this file should be able to check the rule holds by grepping for `err(`
 * and `out(`, not by tracing which strings a target can reach.
 */
/**
 * Every failure lands on a deliberate code — never on Node's default uncaught-exception exit of 1,
 * which is the code reserved for "your system violated an invariant".
 *
 * The promise chain below only covers rejections of `run` itself. stampede *executes the user's
 * config* by design, so a stray unhandled rejection from it would otherwise exit 1 no matter what
 * `process.exitCode` was set to — telling CI the target broke an invariant because someone forgot
 * an `await`. These two handlers are what make the claim above true rather than aspirational.
 */
const exitOnStrayFailure = (label: string) => (error: unknown) => {
  // `plain` here as everywhere else that writes free text. This handler was the one door that
  // skipped it, and a target can reach it: a config with a floating `Promise.reject(new
  // Error(res.text))` in `onResponse` produces a stack whose first line is the target's own
  // response body, printed with its escapes live. Newlines are kept — a stack without them is
  // unreadable — by stripping each line rather than the whole string. What that accepts, stated: a
  // message containing `\n` still injects *lines*, and a well-chosen one reads as a forged
  // `    at …` frame. A flattened stack is the worse trade, so this is the one deliberately.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  err(`stampede: ${label}: ${detail.split("\n").map(plain).join("\n")}`);
  process.exit(ExitCode.RunFailed);
};
process.on("unhandledRejection", exitOnStrayFailure("unhandled rejection"));
process.on("uncaughtException", exitOnStrayFailure("uncaught exception"));

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    err(`stampede: ${plain(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = ExitCode.RunFailed;
  });

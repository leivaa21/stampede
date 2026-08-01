import { HELP, parseArgs } from "./cli/args.ts";
import { renderSummary, renderVerdict } from "./cli/render.ts";
import { ExitCode, runFromConfig, type ExitCodeValue } from "./cli/run-command.ts";
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

const run = async (argv: readonly string[]): Promise<ExitCodeValue> => {
  const args = parseArgs(argv);

  if (args.kind === "help") {
    out(HELP);
    return ExitCode.Ok;
  }
  if (args.kind === "version") {
    out(readVersion(new URL("../package.json", import.meta.url)));
    return ExitCode.Ok;
  }
  if (args.kind === "error") {
    err(`stampede: ${args.message}`);
    err("");
    err(HELP);
    return ExitCode.RunFailed;
  }

  const report = await runFromConfig({ configPath: args.configPath, workers: args.workers });

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
  if (report.verdict !== undefined) {
    out(renderVerdict(report.verdict));
  }
  if (report.failure !== undefined) {
    err(`stampede: ${report.failure}`);
  }

  if (report.exitCode === ExitCode.ThresholdViolated && report.verdict !== undefined) {
    err(`stampede: ${String(report.verdict.violated.length)} threshold(s) violated`);
  }
  return report.exitCode;
};

/**
 * Every failure lands on a deliberate code — never on Node's default uncaught-exception exit of 1,
 * which is the code reserved for "your system violated an invariant".
 */
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    err(`stampede: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = ExitCode.RunFailed;
  });

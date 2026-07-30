import { readVersion } from "./version.ts";

/**
 * Exit codes are part of the contract — CI has to tell "your system broke the invariant" apart
 * from "the tool broke". See docs/design/m1.md, D1-06.
 */
export const ExitCode = {
  Ok: 0,
  ThresholdViolated: 1,
  RunFailed: 2,
} as const;

const main = (argv: readonly string[]): number => {
  const version = readVersion(new URL("../package.json", import.meta.url));

  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${version}\n`);
    return ExitCode.Ok;
  }

  process.stdout.write(
    [
      `stampede ${version} — load testing that proves invariants, not just percentiles.`,
      "",
      "  stampede run <scenarios.ts>                       live TUI",
      "  stampede run <scenarios.ts> --report out.md --ci  headless, thresholds → exit code",
      "",
      "The engine is not built yet — see docs/design/m1.md for the milestone in progress.",
      "",
    ].join("\n"),
  );
  return ExitCode.Ok;
};

/**
 * Every startup failure has to land on `RunFailed`, never on Node's default uncaught-exception
 * exit of 1 — `1` means the *target system* violated an invariant, so a broken tool install
 * reporting as a failed threshold is the exact confusion the exit-code contract exists to
 * prevent. This wrapper is also where every later `run` failure will land.
 */
const run = (argv: readonly string[]): number => {
  try {
    return main(argv);
  } catch (error: unknown) {
    process.stderr.write(`stampede: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.RunFailed;
  }
};

process.exitCode = run(process.argv.slice(2));

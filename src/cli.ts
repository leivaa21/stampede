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

process.exitCode = main(process.argv.slice(2));

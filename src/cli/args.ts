/**
 * Argument parsing, by hand.
 *
 * A dependency for this would be a dependency in a tool whose pitch is a small readable codebase,
 * to save forty lines. What it would not save is the part that matters — deciding what a bad
 * invocation *says* — and an unknown flag has to be an error rather than a shrug, because a
 * mistyped `--wrokers` that silently ran with the default would publish numbers for load nobody
 * asked for.
 */

export interface RunArgs {
  readonly kind: "run";
  readonly configPath: string;
  /** Overrides the config's own `workers`, which in turn overrides the default. */
  readonly workers: number | undefined;
  /** Where to write the markdown report, if anywhere. */
  readonly reportPath: string | undefined;
}

export type ParsedArgs =
  | RunArgs
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

const asPositiveInteger = (raw: string | undefined, flag: string): number | { error: string } => {
  if (raw === undefined || raw.startsWith("-")) {
    // Without the second check `--workers --report x` blames the *value* for not being a number,
    // when what actually happened is that the flag was given nothing.
    return { error: `${flag} needs a value` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return { error: `${flag} must be a whole number of at least 1, got "${raw}"` };
  }
  return value;
};

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    return { kind: "version" };
  }

  const [command, ...rest] = argv;
  if (command !== "run") {
    return {
      kind: "error",
      message: `Unknown command "${String(command)}" — did you mean \`run\`?`,
    };
  }

  let configPath: string | undefined;
  let workers: number | undefined;
  let reportPath: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--workers") {
      const parsed = asPositiveInteger(rest[index + 1], "--workers");
      if (typeof parsed !== "number") {
        return { kind: "error", message: parsed.error };
      }
      workers = parsed;
      index += 1;
      continue;
    }
    if (argument === "--report") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        // Consuming a following flag would write the report to a file called "--workers".
        return { kind: "error", message: "--report needs a file path" };
      }
      reportPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      return { kind: "error", message: `Unknown option "${argument}"` };
    }
    if (configPath !== undefined) {
      return {
        kind: "error",
        message: `Expected one config file, got two: "${configPath}" and "${argument}"`,
      };
    }
    configPath = argument;
  }

  if (configPath === undefined) {
    return {
      kind: "error",
      message: "`run` needs a config file — try `stampede run scenarios.ts`",
    };
  }
  return { kind: "run", configPath, workers, reportPath };
};

export const HELP = `stampede — load testing that proves invariants, not just percentiles

  stampede run <scenarios.ts>              run the scenarios in a config file
  stampede run <scenarios.ts> --workers 4  override the worker-thread count
  stampede run <scenarios.ts> --report out.md   write a markdown report

  --help, -h        this message
  --version, -v     print the version

Exit codes
  0   every threshold held
  1   a threshold was violated — your system broke an invariant
  2   the run itself failed — bad config, unreachable target, nothing measured
`;

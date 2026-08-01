import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

/** Asserts the parse failed, and hands back the message so a test can say what it should contain. */
const errorMessage = (argv: readonly string[]): string => {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "error") {
    throw new Error(`expected a parse error, got "${parsed.kind}"`);
  }
  return parsed.message;
};

describe("parseArgs", () => {
  it("takes a config path", () => {
    expect(parseArgs(["run", "scenarios.ts"])).toEqual({
      kind: "run",
      configPath: "scenarios.ts",
      workers: undefined,
    });
  });

  it("takes a worker override", () => {
    expect(parseArgs(["run", "scenarios.ts", "--workers", "4"])).toMatchObject({ workers: 4 });
  });

  it("shows help with no arguments at all", () => {
    expect(parseArgs([]).kind).toBe("help");
  });

  it.each([["--help"], ["-h"]])("shows help for %s", (flag) => {
    expect(parseArgs([flag]).kind).toBe("help");
  });

  it.each([["--version"], ["-v"]])("prints the version for %s", (flag) => {
    expect(parseArgs([flag]).kind).toBe("version");
  });

  it("refuses an unknown flag rather than running with defaults", () => {
    // A mistyped `--wrokers` that silently ran with the default would publish numbers for load
    // nobody asked for — the whole point of the tool is that its numbers mean what they say.
    expect(errorMessage(["run", "s.ts", "--wrokers", "4"])).toContain("--wrokers");
  });

  it("refuses a worker count that is not a positive whole number", () => {
    for (const bad of ["0", "-1", "2.5", "many", ""]) {
      expect(parseArgs(["run", "s.ts", "--workers", bad]).kind).toBe("error");
    }
  });

  it("blames a negative count as a bad value, not a missing one", () => {
    // `-1` is something wrong; `--report` is nothing at all. Same rejection, different diagnosis.
    expect(errorMessage(["run", "s.ts", "--workers", "-1"])).toContain("at least 1");
    expect(errorMessage(["run", "s.ts", "--workers", "--report"])).toContain("needs a value");
  });

  it("refuses --workers with nothing after it", () => {
    expect(parseArgs(["run", "s.ts", "--workers"])).toMatchObject({ kind: "error" });
  });

  it("takes a report path", () => {
    expect(parseArgs(["run", "s.ts", "--report", "out.md"])).toMatchObject({
      reportPath: "out.md",
    });
  });

  it("refuses a flag where a value should be, rather than using it as one", () => {
    // `--report --workers 4` would otherwise write the report to a file called "--workers".
    expect(errorMessage(["run", "s.ts", "--report", "--workers"])).toContain("needs a file path");
    expect(errorMessage(["run", "s.ts", "--workers", "--report"])).toContain("needs a value");
  });

  it("refuses two config files instead of silently picking one", () => {
    expect(errorMessage(["run", "a.ts", "b.ts"])).toContain("two");
  });

  it("asks for a config when `run` was given none", () => {
    expect(errorMessage(["run"])).toContain("stampede run scenarios.ts");
  });

  it("names the command it did not recognise", () => {
    expect(errorMessage(["runn", "s.ts"])).toContain("runn");
  });
});

import { describe, expect, it } from "vitest";
import { cell, codeSpan, orderedKeys, plain } from "./format.ts";

/**
 * The two functions that stand between a target's bytes and a published document.
 *
 * Names reach these from three places: a config the user wrote, a threshold they named, and — the
 * one that matters here — response data. `record.count(res.headers["x-request-id"])` is
 * `metrics/validate.ts`'s own worked example, which means a *target* can choose a string this tool
 * writes into a terminal, a CI log, and a markdown file someone pastes into a README.
 *
 * Written with named constants rather than the literal bytes: an invisible character in a
 * test is a test nobody can read, and this is a file a stranger will want to understand quickly.
 */

const ESC = "\u001b";
/** CSI in its single-byte C1 form — a second way to write an escape, and it works in a terminal. */
const CSI = "\u009b";

describe("plain", () => {
  it("removes an ANSI escape, so a target cannot print its own verdict", () => {
    expect(plain(`${ESC}[32mPASS everything${ESC}[0m`)).toBe(" [32mPASS everything [0m");
  });

  it("removes a carriage return, which would overwrite the line above it", () => {
    expect(plain("harmless\rPASS")).toBe("harmless PASS");
  });

  it("removes the C1 range too, not only the familiar escape", () => {
    expect(plain(`${CSI}2Kgone`)).toBe(" 2Kgone");
  });

  it("replaces with a space rather than deleting, so two names cannot collide", () => {
    // Deleting would turn `a\u0000b` into `ab`, silently merging it with a different metric — a
    // counter reporting the sum of two things nobody asked to add together.
    expect(plain("a\u0000b")).toBe("a b");
  });

  it("leaves ordinary text, punctuation and emoji alone", () => {
    expect(plain("reserved201 · seat-4 🎟")).toBe("reserved201 · seat-4 🎟");
  });
});

describe("cell", () => {
  it("escapes a pipe, which would otherwise truncate a published claim", () => {
    expect(cell("a|b")).toBe("a\\|b");
  });

  it("flattens a newline, which would end the table and take every row below it", () => {
    expect(cell("line one\nline two")).toBe("line one line two");
  });

  it("strips control characters too, so a pasted report is not a second-class surface", () => {
    expect(cell(`${ESC}[31mred`)).toBe("[31mred");
  });
});

describe("orderedKeys", () => {
  it("puts `other` last however it was declared", () => {
    expect(orderedKeys({ other: 1, zeta: 2, alpha: 3 })).toEqual(["alpha", "zeta", "other"]);
  });

  it("sorts by name, not by the order the object happens to iterate", () => {
    // Integer-like keys iterate numerically whatever the insertion order, so a test using only
    // those proves a property of JavaScript rather than of this function. Mixed keys are what
    // distinguish sorting from passing `Object.keys` through.
    expect(orderedKeys({ zeta: 1, "500": 2, alpha: 3, "200": 4 })).toEqual([
      "200",
      "500",
      "alpha",
      "zeta",
    ]);
  });

  it("omits `other` when it is not there", () => {
    expect(orderedKeys({ b: 1, a: 2 })).toEqual(["a", "b"]);
  });
});

describe("codeSpan", () => {
  it("strips control characters, like its sibling does", () => {
    // Its one non-constant caller is the config path in the report's provenance block. A filename
    // may contain a newline, which ends the code span and lets the rest be read as markdown — a
    // fake heading inside an artifact whose purpose is being pasted into a PR.
    expect(codeSpan("scenarios\n## PASSED\n.ts")).not.toContain("\n");
    expect(codeSpan("a\u001b[31mb")).toBe("`a [31mb`");
  });

  it("still neutralises the backtick that would break the span", () => {
    expect(codeSpan("a`b")).toBe("`a'b`");
  });
});

import { describe, expect, it } from "vitest";
import { cell, orderedKeys, plain } from "./format.ts";

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

  it("is stable for integer-like keys, which JavaScript would hoist", () => {
    // `{ "500": 1, "200": 2 }` iterates as 200, 500 whatever the insertion order — a natural
    // status-code key space would reorder itself, and a report has to reproduce byte-identically.
    expect(orderedKeys({ "500": 1, "200": 2, other: 0 })).toEqual(["200", "500", "other"]);
    expect(orderedKeys({ "200": 2, "500": 1, other: 0 })).toEqual(["200", "500", "other"]);
  });

  it("omits `other` when it is not there", () => {
    expect(orderedKeys({ b: 1, a: 2 })).toEqual(["a", "b"]);
  });
});

import { describe, expect, it } from "vitest";
import { deepFreeze, isFrozenStateViolation } from "./freeze-state.ts";

/**
 * The guard behind D25-02: `request()` must be a pure function of `(state, ordinal)`.
 *
 * The violation that actually happens is consuming shared state, and it is worse than it looks —
 * every worker holds its own structured clone, so `state.seats.pop()` hands four threads the same
 * four values rather than sixteen distinct ones, and no threshold would catch the result.
 */

describe("deepFreeze", () => {
  it("freezes nested objects, not just the top level", () => {
    const state = deepFreeze({ show: { id: "abc", seats: ["a", "b"] } });

    expect(Object.isFrozen(state.show)).toBe(true);
    expect(Object.isFrozen(state.show.seats)).toBe(true);
  });

  it("makes the mistake this exists to catch throw", () => {
    const state = deepFreeze({ seats: ["a", "b"] });

    expect(() => state.seats.pop()).toThrow(TypeError);
    expect(state.seats).toEqual(["a", "b"]);
  });

  it("survives a cycle, which structured clone preserves", () => {
    // `state.self = state` crosses the worker boundary intact, so a naive walk recurses forever.
    const state: Record<string, unknown> = { id: "abc" };
    state.self = state;

    expect(() => deepFreeze(state)).not.toThrow();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("handles the same object reached twice without recursing on it twice", () => {
    const shared = { seats: ["a"] };
    const state = deepFreeze({ left: shared, right: shared });

    expect(Object.isFrozen(state.left.seats)).toBe(true);
  });

  it("leaves primitives and null alone", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("id")).toBe("id");
  });

  it("does not invoke a getter while freezing", () => {
    // A cloned state has no accessors — `structuredClone` materialises them first — so this never
    // fires in a run. It matters because `deepFreeze` is exported: reading a getter to freeze its
    // result would run someone's code as a side effect of sealing an object.
    let reads = 0;
    const state = {
      get expensive() {
        reads += 1;
        return { deep: true };
      },
    };

    deepFreeze(state);

    expect(reads).toBe(0);
  });

  it("leaves built-ins alone, because freezing them is worse than not", () => {
    // `Object.freeze` *throws* on a non-empty typed array, and a `Buffer` in setup state is the
    // canonical shape for an authed API — blanket-freezing killed every worker with a raw V8
    // string. Freezing a RegExp is quieter and worse: `lastIndex` becomes non-writable, so a pure
    // `re.test(...)` throws a message this module's own matcher reads as a purity violation.
    const state = deepFreeze({ key: new Uint8Array([1, 2, 3]), re: /x/g, when: new Date() });

    expect(state.key).toHaveLength(3);
    expect(state.re.test("x")).toBe(true);
    expect(Object.isFrozen(state.key)).toBe(false);
  });

  it("does not catch a mutated Map, Set or Date — the limitation is stated, not implied", () => {
    // The guard's job is the mistake people actually make. Crashing on a `Buffer` to theoretically
    // catch a mutated `Date` is the worse trade, and pretending otherwise is the bigger lie.
    const state = deepFreeze({ byId: new Map([["a", 1]]) });

    expect(() => state.byId.set("b", 2)).not.toThrow();
  });
});

describe("isFrozenStateViolation", () => {
  it("recognises assignment to a frozen property", () => {
    const state = deepFreeze({ id: "abc" });
    let thrown: unknown;

    try {
      state.id = "changed";
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isFrozenStateViolation(thrown)).toBe(true);
  });

  it("recognises `pop` on a frozen array, which throws a different message", () => {
    // `Array.prototype.pop` says "Cannot delete property", not "read only property" — matching one
    // string would have missed the exact call the contract names.
    const state = deepFreeze({ seats: ["a"] });
    let thrown: unknown;

    try {
      state.seats.pop();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isFrozenStateViolation(thrown)).toBe(true);
  });

  it("recognises adding a property to a frozen object", () => {
    const state = deepFreeze<Record<string, unknown>>({});
    let thrown: unknown;

    try {
      state.added = 1;
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isFrozenStateViolation(thrown)).toBe(true);
  });

  it("does not claim an unrelated error", () => {
    // A builder that throws for its own reasons is the build failure the dispatcher counts, and
    // rewriting it as a purity error would send a reader to the wrong contract.
    expect(isFrozenStateViolation(new TypeError("Cannot read properties of undefined"))).toBe(
      false,
    );
    expect(isFrozenStateViolation(new Error("no seat for that ordinal"))).toBe(false);
    expect(isFrozenStateViolation(undefined)).toBe(false);
  });
});

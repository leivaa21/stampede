import { describe, expect, it } from "vitest";
import { guardState, StateMutationError } from "./guard-state.ts";

/**
 * The guard behind D25-02: `request()` must be a pure function of `(state, ordinal)`.
 *
 * The violation that actually happens is consuming shared state, and it is worse than it looks —
 * every worker holds its own structured clone, so `state.seats.pop()` hands four threads the same
 * four values rather than sixteen distinct ones, and no threshold would catch the result.
 *
 * These run in a strict ES module, so they cannot prove the property that made this a proxy rather
 * than a freeze. That claim — enforcement in sloppy mode, where a frozen write is discarded in
 * silence — is asserted end to end in `cli/run-command.test.ts`, against a config Node genuinely
 * loads as CommonJS.
 */

describe("guardState", () => {
  it("refuses the mistake this exists to catch, and says which field", () => {
    const state = guardState({ seats: ["a", "b"] });

    expect(() => state.seats.pop()).toThrow(StateMutationError);
    expect(state.seats).toEqual(["a", "b"]);
  });

  it("carries the path from the state root, not just the property", () => {
    // A config may read a dozen fields; `state.show.seats.1` says which one the builder consumed.
    // This is the gain over matching V8's message, which named the operation and nothing else.
    const state = guardState({ show: { seats: ["a", "b"] } });

    expect(() => state.show.seats.pop()).toThrow(/state\.show\.seats\.1/);
  });

  it("refuses every shape of write, not only assignment", () => {
    const state = guardState<Record<string, unknown>>({ id: "abc", seats: ["b", "a"] });

    expect(() => {
      state.id = "changed";
    }).toThrow(StateMutationError);
    expect(() => {
      state.fresh = 1;
    }).toThrow(StateMutationError);
    expect(() => {
      delete state.id;
    }).toThrow(StateMutationError);
    expect(() => Object.defineProperty(state, "z", { value: 1 })).toThrow(StateMutationError);
    expect(() => {
      Object.setPrototypeOf(state, null);
    }).toThrow(StateMutationError);
    expect(() => (state.seats as string[]).push("b")).toThrow(StateMutationError);
    expect(() => (state.seats as string[]).sort()).toThrow(StateMutationError);
    // Not a write, but the remaining way to change the object's shape. Without the trap
    // `Object.freeze(state)` half-applies: extensions silently prevented, then `defineProperty`
    // throws — and "any write, at any depth, throws" stops being exactly true.
    expect(() => Object.preventExtensions(state)).toThrow(StateMutationError);
  });

  it("guards nested objects, not just the top level", () => {
    const state = guardState({ show: { id: "abc", seats: ["a", "b"] } });

    expect(() => {
      state.show.id = "changed";
    }).toThrow(StateMutationError);
  });

  it("leaves every read exactly as it was", () => {
    // The builder's whole job. A guard that broke spreading or iteration would be worse than the
    // bug it prevents.
    const state = guardState({ url: "http://x/", seats: ["a", "b"], nested: { n: 1 } });

    expect(state.url).toBe("http://x/");
    expect(state.seats[1]).toBe("b");
    expect(state.seats.map((s) => s.toUpperCase())).toEqual(["A", "B"]);
    expect({ ...state }.nested.n).toBe(1);
    expect(JSON.parse(JSON.stringify(state))).toEqual({
      url: "http://x/",
      seats: ["a", "b"],
      nested: { n: 1 },
    });
  });

  it("survives a cycle, which structured clone preserves", () => {
    // `state.self = state` crosses the worker boundary intact, so a naive walk recurses forever.
    const state: Record<string, unknown> = { id: "abc" };
    state.self = state;

    const guarded = guardState(state);

    expect(() => {
      (guarded.self as Record<string, unknown>).id = "changed";
    }).toThrow(StateMutationError);
  });

  it("returns the same proxy for a child reached twice, so identity still holds", () => {
    // `state.left === state.right` held before the guard was applied and must go on holding, or
    // the guard has changed what the builder sees rather than only what it may do.
    const shared = { seats: ["a"] };
    const state = guardState({ left: shared, right: shared });

    expect(state.left).toBe(state.right);
  });

  it("reports a shared child under the branch walked first — the memo's stated cost", () => {
    // The price of the identity above: one proxy, so one path. Writing through `right` names
    // `left`. Asserted rather than only commented, because a reader who hits this message needs to
    // know the field named may be an alias and not the one their code says.
    const shared = { seats: ["a"] };
    const state = guardState({ left: shared, right: shared });

    expect(() => state.right.seats.push("b")).toThrow(/state\.left\.seats\.1/);
  });

  it("leaves primitives and null alone", () => {
    expect(guardState(null)).toBeNull();
    expect(guardState(42)).toBe(42);
    expect(guardState("id")).toBe("id");
  });

  it("does not invoke a getter while walking", () => {
    // A cloned state has no accessors — `structuredClone` materialises them first — so this never
    // fires in a run. It matters because reading a getter to wrap its result would run someone's
    // code as a side effect of guarding an object.
    let reads = 0;
    const state = {
      get expensive() {
        reads += 1;
        return { deep: true };
      },
    };

    guardState(state);

    expect(reads).toBe(0);
  });

  it("leaves built-ins alone, because wrapping them would break them", () => {
    // A `Map` behind a proxy throws `called on incompatible receiver` — its methods reach for
    // internal slots the proxy does not have — and a `Buffer` in setup state is the canonical shape
    // for load-testing an authed API. Wrapping them would break working configs to catch nothing:
    // no `set` trap fires for `map.set(k, v)` either way.
    const state = guardState({
      key: new Uint8Array([1, 2, 3]),
      byId: new Map([["a", 1]]),
      re: /x/g,
    });

    expect(state.key).toHaveLength(3);
    expect(state.re.test("x")).toBe(true);
    expect(state.byId.get("a")).toBe(1);
  });

  it("does not catch a mutated Map or Set — the limitation is stated, not implied", () => {
    // The guard's job is the mistake people actually make. Breaking every `Buffer` config to
    // theoretically catch a mutated `Map` is the worse trade, and pretending otherwise is the
    // bigger lie.
    const state = guardState({ byId: new Map([["a", 1]]) });

    expect(() => state.byId.set("b", 2)).not.toThrow();
  });
});

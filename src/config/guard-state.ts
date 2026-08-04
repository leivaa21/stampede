/**
 * Making the setup state refuse mutation, in any module system (D25-02).
 *
 * `request(state, ordinal)` is documented as a **pure function of its arguments**. The violation
 * that actually happens is consuming shared state — `state.seats.pop()` — and it is worse than it
 * looks: every worker receives its own structured clone, so four threads pop the same four values
 * rather than sixteen distinct ones, and the run publishes numbers that are wrong in a way no
 * threshold would catch. The ordinal exists precisely so variation can be *derived*.
 *
 * **Why a proxy and not `Object.freeze`.** A frozen object only *throws* in strict mode. In sloppy
 * mode the write is discarded in silence — measured on Node 24, `state.nonce += 1` against frozen
 * state simply does nothing — which is this guard switched off, and worse than off, since the
 * user's own mutation does not happen either. Whether a config is sloppy depends on the module
 * system Node picks for it, which depends on the nearest `package.json` *and* on the file's own
 * syntax. An earlier attempt to settle that question up front got it wrong twice, and the second
 * time it refused the majority of Node projects — a `package.json` with no `"type"` field loads as
 * a strict ES module, not as CommonJS.
 *
 * A proxy trap does not have that dependency. The throw comes from the trap, not from assignment
 * semantics, so it fires in sloppy mode too and the question stops needing an answer.
 *
 * The trap also *knows what was touched*, so the error carries `state.seats.0` rather than leaving
 * the caller to recognise a V8 message. That retires a regex over strings like "Cannot delete
 * property" — three of which had to be matched, because the operation decided the wording.
 *
 * Applied in the worker, after the clone: `structuredClone` cannot carry a proxy, so wrapping on
 * the main thread would protect nothing.
 */

/**
 * A write the guard refused, carrying the path that was written to.
 *
 * Distinct from `ImpureRequestError` so that this module stays about *state* and knows nothing
 * about scenarios: `to-run.ts` adds the scenario name and the contract, because it is the one that
 * knows both.
 */
export class StateMutationError extends Error {
  /** Dotted path from the state root, e.g. `state.seats.0`. */
  readonly path: string;

  constructor(path: string) {
    super(`the setup state was mutated at \`${path}\``);
    this.name = "StateMutationError";
    this.path = path;
  }
}

/**
 * Only plain objects and arrays are wrapped. Everything else is left exactly as it arrived.
 *
 * A `Map`, `Set`, `Date` or typed array behind a proxy still mutates: their methods operate on
 * internal slots, which no trap can see — `proxy.set(k, v)` on a wrapped `Map` succeeds and no
 * `set` trap fires. Wrapping them would therefore buy nothing while breaking them, since those same
 * methods throw on a proxy whose target holds the slots (`Method Map.prototype.set called on
 * incompatible receiver`). A `Buffer` in setup state is the canonical shape for load-testing an
 * authed API — `setup: () => ({ signingKey: randomBytes(32) })` — and it has to keep working.
 *
 * **What that leaves unguarded, stated rather than implied:** a `Map`, `Set`, `Date`, `Error` or
 * typed array in the setup state can still be mutated by a builder, and this will not catch it.
 * They are rare in setup state, and the guard's job is the mistake people actually make: consuming
 * an array or reassigning a field.
 */
const isGuardable = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return true;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Wraps `value` so that any write to it, at any depth, throws `StateMutationError`.
 *
 * Children are wrapped **in place, before the proxy is handed out**, so it needs no `get` trap: a
 * read finds an already-wrapped child sitting on the target. Reads are still proxy reads — measured
 * on Node 24, a build against guarded state costs ~106 ns against ~2 ns plain — but a memoised
 * `get` trap costs ~306 ns for the same shape, so this is the cheaper of the two guards by 3x.
 * Neither is visible next to a network round trip; the argument for doing it this way is that a
 * `get` trap would also have to re-derive child identity on every read, and `state.left ===
 * state.right` has to keep holding.
 *
 * Module-level, called only by `worker-entry.ts`, so the only value it ever sees is a
 * post-`structuredClone` one — which is why mutating the caller's object in place is safe here.
 */
export const guardState = <T>(value: T): T => {
  // Cycles survive `structuredClone` (`state.self = state`), and a shared child reached twice must
  // come back as the *same* proxy, or `state.left === state.right` would stop holding for a state
  // where it held before the guard was applied.
  const wrapped = new WeakMap<object, unknown>();

  const wrap = (node: unknown, parentPath: string, key?: PropertyKey): unknown => {
    if (!isGuardable(node)) {
      return node;
    }
    const path = key === undefined ? parentPath : `${parentPath}.${String(key)}`;
    if (wrapped.has(node)) {
      return wrapped.get(node);
    }

    const refuse = (key: PropertyKey): never => {
      throw new StateMutationError(`${path}.${String(key)}`);
    };
    const proxy = new Proxy(node, {
      set: (_target, key) => refuse(key),
      deleteProperty: (_target, key) => refuse(key),
      defineProperty: (_target, key) => refuse(key),
      setPrototypeOf: () => refuse("[[Prototype]]"),
      // Not a write, but the one remaining way to change the object's shape: without it
      // `Object.freeze(state)` half-applies — extensions silently prevented, then `defineProperty`
      // throws — and "any write, at any depth, throws" stops being exactly true.
      preventExtensions: () => refuse("[[Extensible]]"),
    });
    // Recorded before descending, so a cycle finds the proxy rather than recursing forever.
    wrapped.set(node, proxy);

    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(node, key);
      // Accessors are not read: a cloned state has none — `structuredClone` materialises them into
      // data properties first — and reading a getter to wrap its result would run someone's code as
      // a side effect. Non-writable or non-configurable properties are left alone because assigning
      // the wrapper back would throw here, in the guard, rather than in the builder — and the cost
      // of skipping is worth naming: with no `get` trap, a read of that property returns the *raw*
      // child, so its whole subtree is unguarded. Unreachable on the shipped path, where every
      // property arrives from `structuredClone` as `writable: true, configurable: true`.
      if (
        descriptor?.get === undefined &&
        descriptor?.set === undefined &&
        descriptor?.writable === true
      ) {
        // The path is built inside `wrap`'s guardable branch, not here: a 200k-string array would
        // otherwise allocate 200k template strings at worker startup for values that never wrap.
        node[key] = wrap(node[key], path, key);
      }
    }

    return proxy;
  };

  return wrap(value, "state") as T;
};

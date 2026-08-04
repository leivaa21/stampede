/**
 * Making the setup state immutable for the run (D25-02).
 *
 * `request(state, ordinal)` is documented as a **pure function of its arguments**, and until now
 * nothing checked it. The violation that actually happens is consuming shared state —
 * `state.seats.pop()` — and it is worse than it looks: every worker receives its own structured
 * clone, so four threads pop the same four values rather than sixteen distinct ones, and the run
 * publishes numbers that are wrong in a way no threshold would catch. The ordinal exists precisely
 * so variation can be *derived* rather than accumulated.
 *
 * Frozen in the worker, after the clone. `structuredClone` does not preserve frozenness, so
 * freezing on the main thread would protect nothing — the copy a builder can reach is the one that
 * has to be sealed.
 */

/**
 * Only plain objects and arrays are frozen. Everything else is left exactly as it arrived.
 *
 * This is a correctness requirement, not a simplification. `Object.freeze` **throws** on a
 * non-empty typed array (`Cannot freeze array buffer views with elements`), and a `Buffer` in the
 * setup state is the canonical shape for load-testing an authed API — `setup: () => ({ signingKey:
 * randomBytes(32) })`. Blanket-freezing killed every worker with that raw V8 string, naming
 * neither stampede nor the config nor a remedy.
 *
 * Freezing a `RegExp` is quieter and worse: it makes `lastIndex` non-writable, so a perfectly pure
 * `re.test(...)` inside `request()` throws — and throws a message this module's own matcher reads
 * as a purity violation, telling the user they mutated state when they mutated nothing.
 *
 * **What that leaves unguarded, stated rather than implied:** a `Map`, a `Set`, a `Date` and a
 * typed array in the setup state can still be mutated by a builder, and this will not catch it.
 * They are rare in structured-cloneable setup state, and the guard's job is the mistake people
 * actually make — consuming an array or reassigning a field. A guard that crashes on a `Buffer` to
 * theoretically catch a mutated `Date` is a worse trade than saying so here.
 */
const isFreezable = (value: unknown): value is Record<PropertyKey, unknown> => {
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
 * Recursively freezes the plain objects and arrays in `value`, in place, and returns it.
 *
 * Cycles are tracked because the setup state is structured-cloneable, and structured clone
 * preserves cycles — `state.self = state` survives the trip and would otherwise recurse forever.
 */
export const deepFreeze = <T>(value: T): T => {
  const seen = new WeakSet<object>();

  const walk = (node: unknown): void => {
    if (!isFreezable(node) || seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(node, key);
      // Accessors are not read. A cloned state has none — `structuredClone` materialises them into
      // data properties, on the main thread, before this runs — so on the production path this
      // never fires. It is here because `deepFreeze` is reachable directly and reading a getter to
      // freeze its result would run someone's code as a side effect of sealing an object.
      if (descriptor?.get === undefined && descriptor?.set === undefined) {
        walk(node[key]);
      }
    }
    Object.freeze(node);
  };

  walk(value);
  return value;
};

/**
 * A builder that mutated the frozen setup state, carried as a type rather than a message.
 *
 * The dispatch path has to tell this from an ordinary build failure, and this repo has been bitten
 * twice by re-deriving that from a string (`instanceof TypeError` could not tell a refused
 * connection from a schema error). One class, checked once.
 */
export class ImpureRequestError extends Error {}

/**
 * Whether a thrown error is what a frozen object throws when something tries to write to it.
 *
 * Matched on the error rather than by pre-checking the builder, because the only way to know a
 * builder mutates is to let it try. Node's messages differ by operation — assignment says "Cannot
 * assign to read only property", adding says "Cannot add property", and `Array.prototype.pop` on a
 * frozen array says "Cannot delete property" — so the set is matched rather than one string.
 *
 * Anchored to the start, because the message this is compared against can embed a user-supplied URL
 * further along (`to-run.ts` interpolates one into its own errors), and an unanchored match over
 * attacker-influenced text is how a matcher starts claiming things it did not mean.
 */
export const isFrozenStateViolation = (error: unknown): boolean =>
  error instanceof TypeError &&
  /^Cannot (assign to read only property|add property|delete property)|^.{0,40}object is not extensible/.test(
    error.message,
  );

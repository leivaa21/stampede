/**
 * Making the setup state genuinely immutable for the run (D25-02).
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
 * Recursively freezes `value` in place and returns it.
 *
 * Cycles are tracked because the setup state is structured-cloneable, and structured clone
 * preserves cycles — `state.self = state` survives the trip and would otherwise recurse forever.
 *
 * `Map` and `Set` are frozen as objects, which stops replacement but not `map.set(...)`: freezing
 * cannot seal their internals. That is stated rather than papered over — the guard catches the
 * realistic mistake (mutating a plain object or array), and a `Map` in setup state is rare enough
 * that pretending otherwise would be the bigger lie.
 */
export const deepFreeze = <T>(value: T, seen: WeakSet<object> = new WeakSet()): T => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    // Getters are left alone: reading one to freeze its result would run user code at startup, and
    // a getter's value is not a thing that can be frozen in place anyway.
    if (descriptor?.get === undefined && descriptor?.set === undefined) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
    }
  }

  return Object.freeze(value);
};

/**
 * Whether a thrown error is what a frozen object throws when something tries to write to it.
 *
 * Matched on the error rather than by pre-checking the builder, because the only way to know a
 * builder mutates is to let it try. Node's messages differ by operation — "Cannot assign to read
 * only property", "Cannot add property", "object is not extensible", and `Array.prototype.pop` on
 * a frozen array says "Cannot delete property" — so the set is matched rather than one string.
 */
export const isFrozenStateViolation = (error: unknown): boolean =>
  error instanceof TypeError &&
  /read only property|not extensible|Cannot add property|Cannot delete property|object is not extensible/i.test(
    error.message,
  );

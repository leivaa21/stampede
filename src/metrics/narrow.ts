/**
 * Narrowing primitives for values arriving from a worker port.
 *
 * `postMessage` delivers `unknown`, and a snapshot that is merely *shaped* wrong — a `Float64Array`
 * of `NaN` where an `Int32Array` belongs — does not crash, it produces a plausible number. So the
 * boundary narrows rather than casts, and every failure names the field it was looking at.
 */

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

const fail = (path: string, expected: string, value: unknown): never => {
  throw new SnapshotFormatError(`${path} must be ${expected}, got ${describe(value)}`);
};

/**
 * `Object.create(null)` has no `constructor`, so reading `value.constructor.name` throws — and a
 * formatter whose whole contract is "names the field instead of crashing" must not be the thing
 * that crashes. TypeScript types `constructor` as always present, which is why this restates the
 * shape it actually has rather than trusting the built-in one.
 */
const constructorName = (value: object): string | undefined => {
  const { constructor } = value as { readonly constructor?: { readonly name?: unknown } };
  return typeof constructor?.name === "string" ? constructor.name : undefined;
};

const describe = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return constructorName(value) ?? "an object";
  }
  return typeof value;
};

export const objectAt = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "an object", value);
  }
  return value as Readonly<Record<string, unknown>>;
};

/** A `Map` keyed by strings, re-read entry by entry — the key type is not guaranteed by the wire. */
export const nameMapAt = (value: unknown, path: string): ReadonlyMap<string, unknown> => {
  if (!(value instanceof Map)) {
    return fail(path, "a Map", value);
  }
  const entries: ReadonlyMap<unknown, unknown> = value;
  const narrowed = new Map<string, unknown>();
  for (const [name, entry] of entries) {
    if (typeof name !== "string") {
      return fail(path, "a Map keyed by strings", name);
    }
    narrowed.set(name, entry);
  }
  return narrowed;
};

export const int32ArrayAt = (value: unknown, path: string): Int32Array => {
  if (!(value instanceof Int32Array)) {
    return fail(path, "an Int32Array", value);
  }
  return value;
};

export const booleanAt = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    return fail(path, "a boolean", value);
  }
  return value;
};

/** A non-negative safe integer — every number in a snapshot is a tally or a sequence. */
export const tallyAt = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(path, "a non-negative safe integer", value);
  }
  return value;
};

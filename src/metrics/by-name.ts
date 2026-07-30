/**
 * Helpers for the name-keyed maps every metric container is built from.
 *
 * Both of them emit entries in name order. That is not cosmetic: two runs that merged the same
 * per-worker snapshots in a different order must produce byte-identical output, or a report stops
 * being reproducible (D1-02).
 */

/** Code-unit order, not locale order — a published report must reproduce on any machine. */
export const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byName = <T>([a]: readonly [string, T], [b]: readonly [string, T]): number =>
  compareNames(a, b);

/** Projects every entry of a name-keyed map into a new one, in name order. */
export const mapByName = <T, U>(
  source: ReadonlyMap<string, T>,
  project: (value: T) => U,
): Map<string, U> => {
  const projected = new Map<string, U>();
  for (const [name, value] of [...source].sort(byName)) {
    projected.set(name, project(value));
  }
  return projected;
};

/**
 * Merges two name-keyed maps over the union of their names, in name order. A name present on only
 * one side is still merged — against `empty()` — so the result never aliases either operand.
 */
export const mergeByName = <T>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, T>,
  empty: () => T,
  merge: (a: T, b: T) => T,
): Map<string, T> => {
  const names = [...new Set([...left.keys(), ...right.keys()])].sort(compareNames);
  const merged = new Map<string, T>();
  for (const name of names) {
    merged.set(name, merge(left.get(name) ?? empty(), right.get(name) ?? empty()));
  }
  return merged;
};

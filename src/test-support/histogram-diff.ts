import { expect } from "vitest";
import type { HistogramSnapshot } from "../metrics/snapshots.ts";

/**
 * Exact histogram-snapshot equality that names the bucket it differs on.
 *
 * `toEqual` walks a 17,408-element `Int32Array` in JS. Twenty-four orderings of that took the merge
 * suite past vitest's 5s default on a loaded machine — which looked exactly like flakiness in a
 * suite that is deterministic by construction. Comparing the bytes is the same assertion at native
 * speed; the element scan below runs only on mismatch, and only to say *which* bucket moved, which
 * is what makes a failure diagnosable rather than a wall of base64.
 */
export const expectSameHistogram = (
  actual: HistogramSnapshot,
  expected: HistogramSnapshot,
  where: Readonly<Record<string, string>> = {},
): void => {
  expect({ ...where, overflowCount: actual.overflowCount }).toEqual({
    ...where,
    overflowCount: expected.overflowCount,
  });
  expect({ ...where, saturated: actual.saturated }).toEqual({
    ...where,
    saturated: expected.saturated,
  });
  // Length first: without it a prefix mismatch could differ bytewise while no element did, and the
  // scan below would then have nothing to report.
  expect({ ...where, buckets: actual.counts.length }).toEqual({
    ...where,
    buckets: expected.counts.length,
  });

  // `byteOffset`/`byteLength`, not the whole backing buffer: a view into a larger `ArrayBuffer`
  // would otherwise compare bytes nobody asked about, in the helper whose point is byte-exactness.
  const bytes = (counts: Int32Array): Buffer =>
    Buffer.from(counts.buffer, counts.byteOffset, counts.byteLength);
  if (bytes(actual.counts).equals(bytes(expected.counts))) {
    return;
  }
  // Reachable by construction now that the lengths match: equal-length Int32Arrays cannot differ
  // bytewise without differing element-wise.
  const bucket = actual.counts.findIndex((count, index) => count !== expected.counts[index]);
  expect({ ...where, bucket, count: actual.counts[bucket] }).toEqual({
    ...where,
    bucket,
    count: expected.counts[bucket],
  });
};

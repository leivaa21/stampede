import { COUNTS_LENGTH } from "./histogram-layout.ts";
import {
  booleanAt,
  int32ArrayAt,
  nameMapAt,
  objectAt,
  SnapshotFormatError,
  tallyAt,
} from "./narrow.ts";
import type {
  ChecksSnapshot,
  CheckTally,
  CountersSnapshot,
  HistogramSnapshot,
  RegistrySnapshot,
  ScenarioSnapshot,
} from "./snapshots.ts";

/**
 * The untrusted-input boundary for worker metrics.
 *
 * Narrow **once**, here, at the outermost entry. Everything below (`MetricsRegistry.fromSnapshot`
 * and friends) takes an already-narrowed type and trusts it, which is only honest because the one
 * documented way in — `SnapshotAggregator.update` — takes `unknown` and comes through this file.
 * Guards spread across every level would each be one `as`-cast at the call site away from
 * decorative.
 */

const parseTally = (value: unknown, path: string): CheckTally => {
  const tally = objectAt(value, path);
  return {
    passed: tallyAt(tally.passed, `${path}.passed`),
    failed: tallyAt(tally.failed, `${path}.failed`),
  };
};

export const parseHistogramSnapshot = (value: unknown, path: string): HistogramSnapshot => {
  const snapshot = objectAt(value, path);
  const counts = int32ArrayAt(snapshot.counts, `${path}.counts`);
  if (counts.length !== COUNTS_LENGTH) {
    throw new SnapshotFormatError(
      `${path}.counts must have ${String(COUNTS_LENGTH)} buckets, got ${String(counts.length)}`,
    );
  }

  for (const count of counts) {
    if (count < 0) {
      throw new SnapshotFormatError(`${path}.counts has a negative bucket count`);
    }
  }

  const overflowCount = tallyAt(snapshot.overflowCount, `${path}.overflowCount`);
  const saturated = booleanAt(snapshot.saturated, `${path}.saturated`);
  const topBucketCount = counts[COUNTS_LENGTH - 1] ?? 0;

  // Every overflowed sample is clamped into the *top* bucket specifically, so the invariant is
  // against that bucket, not against the total — five samples in bucket 0 with `overflowCount: 5`
  // would otherwise parse and report `isLowerBound: true` alongside `max: 0`.
  //
  // Saturation is the one case that legitimately breaks it: merging two histograms adds their
  // overflow counts exactly while their top buckets clamp at the Int32 ceiling, so a saturated
  // snapshot is exempt — its counts are already known to be lower bounds.
  if (!saturated && overflowCount > topBucketCount) {
    throw new SnapshotFormatError(
      `${path}.overflowCount (${String(overflowCount)}) exceeds its top bucket's ${String(topBucketCount)} samples`,
    );
  }

  return { counts, overflowCount, saturated };
};

const parseHistogramsByName = (
  value: unknown,
  path: string,
): ReadonlyMap<string, HistogramSnapshot> => {
  const parsed = new Map<string, HistogramSnapshot>();
  for (const [name, histogram] of nameMapAt(value, path)) {
    parsed.set(name, parseHistogramSnapshot(histogram, `${path}["${name}"]`));
  }
  return parsed;
};

const parseCountersSnapshot = (value: unknown, path: string): CountersSnapshot => {
  const snapshot = objectAt(value, path);
  const totals = new Map<string, number>();
  for (const [name, total] of nameMapAt(snapshot.totals, `${path}.totals`)) {
    totals.set(name, tallyAt(total, `${path}.totals["${name}"]`));
  }
  return { totals, refusedCount: tallyAt(snapshot.refusedCount, `${path}.refusedCount`) };
};

const parseChecksSnapshot = (value: unknown, path: string): ChecksSnapshot => {
  const snapshot = objectAt(value, path);
  const tallies = new Map<string, CheckTally>();
  for (const [name, tally] of nameMapAt(snapshot.tallies, `${path}.tallies`)) {
    tallies.set(name, parseTally(tally, `${path}.tallies["${name}"]`));
  }
  return { tallies, refusedCount: tallyAt(snapshot.refusedCount, `${path}.refusedCount`) };
};

const parseScenarioSnapshot = (value: unknown, path: string): ScenarioSnapshot => {
  const snapshot = objectAt(value, path);
  return {
    histograms: parseHistogramsByName(snapshot.histograms, `${path}.histograms`),
    trends: parseHistogramsByName(snapshot.trends, `${path}.trends`),
    counters: parseCountersSnapshot(snapshot.counters, `${path}.counters`),
    checks: parseChecksSnapshot(snapshot.checks, `${path}.checks`),
    refusedCount: tallyAt(snapshot.refusedCount, `${path}.refusedCount`),
  };
};

/** Narrows a message posted by a worker into a snapshot the rest of `metrics/` can trust. */
export const parseRegistrySnapshot = (value: unknown): RegistrySnapshot => {
  const snapshot = objectAt(value, "snapshot");
  const scenarios = new Map<string, ScenarioSnapshot>();
  for (const [name, scenario] of nameMapAt(snapshot.scenarios, "snapshot.scenarios")) {
    scenarios.set(name, parseScenarioSnapshot(scenario, `snapshot.scenarios["${name}"]`));
  }
  return { sequence: tallyAt(snapshot.sequence, "snapshot.sequence"), scenarios };
};

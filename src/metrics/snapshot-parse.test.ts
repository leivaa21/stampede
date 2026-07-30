import { describe, expect, it } from "vitest";
import { COUNTS_LENGTH } from "./histogram-layout.ts";
import { SnapshotFormatError } from "./narrow.ts";
import { MetricsRegistry } from "./registry.ts";
import { parseHistogramSnapshot, parseRegistrySnapshot } from "./snapshot-parse.ts";

const validRegistry = (): MetricsRegistry => {
  const registry = new MetricsRegistry();
  const metrics = registry.scenario("reads");
  metrics.histogram("latency").record(1_500);
  metrics.trend("behindMs").recordMs(12);
  metrics.counters.inc("requests", 3);
  metrics.checks.record("status ok", true);
  return registry;
};

const validHistogram = (): unknown => ({
  counts: new Int32Array(COUNTS_LENGTH),
  overflowCount: 0,
  saturated: false,
});

describe("parseRegistrySnapshot", () => {
  it("accepts what the registry produces, through a real structured clone", () => {
    const snapshot = structuredClone(validRegistry().toSnapshot(7));

    const parsed = parseRegistrySnapshot(snapshot);

    expect(parsed.sequence).toBe(7);
    expect(MetricsRegistry.fromSnapshot(parsed).toSnapshot(7)).toEqual(snapshot);
  });

  it("rejects payloads that are not snapshots at all", () => {
    for (const notASnapshot of [null, undefined, 42, "snapshot", [], new Date()]) {
      expect(() => parseRegistrySnapshot(notASnapshot)).toThrow(SnapshotFormatError);
    }
  });

  it("rejects a missing or non-tally sequence", () => {
    const snapshot = validRegistry().toSnapshot(1);

    expect(() => parseRegistrySnapshot({ scenarios: snapshot.scenarios })).toThrow(/sequence/);
    expect(() => parseRegistrySnapshot({ ...snapshot, sequence: -1 })).toThrow(/sequence/);
    expect(() => parseRegistrySnapshot({ ...snapshot, sequence: 1.5 })).toThrow(/sequence/);
  });

  it("rejects a scenarios field that is a plain object rather than a Map", () => {
    expect(() => parseRegistrySnapshot({ sequence: 1, scenarios: { reads: {} } })).toThrow(/Map/);
  });

  it("names the field it choked on", () => {
    const snapshot = validRegistry().toSnapshot(1);
    const scenarios = new Map(snapshot.scenarios);
    const reads = scenarios.get("reads");
    scenarios.set("reads", { ...reads, counters: "nope" } as never);

    expect(() => parseRegistrySnapshot({ ...snapshot, scenarios })).toThrow(
      /scenarios\["reads"\]\.counters/,
    );
  });
});

describe("parseHistogramSnapshot", () => {
  it("accepts a well-formed bucket array", () => {
    expect(parseHistogramSnapshot(validHistogram(), "h").counts).toHaveLength(COUNTS_LENGTH);
  });

  // The finding that motivated parsing from `unknown`: a Float64Array of NaN is not an Int32Array,
  // but every arithmetic path downstream accepts it and quietly returns NaN.
  it("rejects a typed array of the wrong kind rather than computing NaN from it", () => {
    const wrongType = new Float64Array(COUNTS_LENGTH).fill(Number.NaN);

    expect(() =>
      parseHistogramSnapshot({ ...(validHistogram() as object), counts: wrongType }, "h"),
    ).toThrow(/Int32Array/);
  });

  it("rejects a bucket array of the wrong length", () => {
    const short = { ...(validHistogram() as object), counts: new Int32Array(COUNTS_LENGTH - 1) };

    expect(() => parseHistogramSnapshot(short, "h")).toThrow(/buckets/);
  });

  it("rejects negative bucket counts", () => {
    const counts = new Int32Array(COUNTS_LENGTH);
    counts[0] = -1;

    expect(() => parseHistogramSnapshot({ ...(validHistogram() as object), counts }, "h")).toThrow(
      /negative/,
    );
  });

  it("rejects a non-boolean saturated flag", () => {
    const truthy = { ...(validHistogram() as object), saturated: 1 };

    expect(() => parseHistogramSnapshot(truthy, "h")).toThrow(/boolean/);
  });

  it("rejects an overflow count larger than the top bucket it must live in", () => {
    const counts = new Int32Array(COUNTS_LENGTH);
    counts[COUNTS_LENGTH - 1] = 2;

    expect(() =>
      parseHistogramSnapshot({ counts, overflowCount: 3, saturated: false }, "h"),
    ).toThrow(/exceeds/);
    expect(
      parseHistogramSnapshot({ counts, overflowCount: 2, saturated: false }, "h"),
    ).toBeDefined();
  });

  // The invariant is against the *top* bucket, not the total: overflowed samples are clamped
  // there specifically, so five samples in bucket 0 claiming five overflows describes a
  // distribution with `isLowerBound: true` and `max: 0`, which cannot exist.
  it("rejects overflow attributed to buckets that are not the top one", () => {
    const counts = new Int32Array(COUNTS_LENGTH);
    counts[0] = 5;

    expect(() =>
      parseHistogramSnapshot({ counts, overflowCount: 5, saturated: false }, "h"),
    ).toThrow(/top bucket/);
  });

  // A saturated merge adds overflow counts exactly while the top bucket clamps, so it is the one
  // case where the invariant legitimately breaks.
  it("exempts a saturated snapshot, whose counts are already lower bounds", () => {
    const counts = new Int32Array(COUNTS_LENGTH);
    counts[COUNTS_LENGTH - 1] = 2 ** 31 - 1;

    expect(
      parseHistogramSnapshot({ counts, overflowCount: 2 ** 31, saturated: true }, "h"),
    ).toBeDefined();
    expect(() =>
      parseHistogramSnapshot({ counts, overflowCount: 2 ** 31, saturated: false }, "h"),
    ).toThrow(/top bucket/);
  });
});

describe("narrowing edge cases", () => {
  it("describes a null-prototype object instead of crashing on its missing constructor", () => {
    const noPrototype: unknown = Object.assign(Object.create(null) as object, { sequence: 1 });

    // The formatter's whole contract is "names the field rather than crashing".
    expect(() => parseRegistrySnapshot(noPrototype)).toThrow(SnapshotFormatError);
    expect(() => parseRegistrySnapshot({ sequence: 1, scenarios: noPrototype })).toThrow(
      /scenarios must be a Map, got an object/,
    );
  });

  it("rejects a Map keyed by something other than a string", () => {
    const numericKeys = new Map<unknown, unknown>([[1, {}]]);

    expect(() => parseRegistrySnapshot({ sequence: 1, scenarios: numericKeys })).toThrow(
      /keyed by strings/,
    );
  });

  it("names the constructor of whatever it was handed", () => {
    expect(() => parseRegistrySnapshot({ sequence: 1, scenarios: new Date() })).toThrow(/got Date/);
    expect(() => parseRegistrySnapshot({ sequence: 1, scenarios: new Set() })).toThrow(/got Set/);
  });
});

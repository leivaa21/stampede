/**
 * Edge validation shared by every metric type.
 *
 * These guards sit on the *recording* surface, which is the real edge: metric names and sample
 * values come from the user's scenario config. Nothing is coerced — a negative latency or a NaN
 * sample is a bug in the caller, and swallowing it would quietly poison a published percentile.
 */

/**
 * Every name in this module is bounded, but by one of two rules, and which rule applies depends on
 * where the name comes from — not on which level of the structure it sits at.
 *
 * **Data-derived names throw nothing; they are refused and counted.** A metric name built from a
 * response — `counters.inc(res.headers["x-request-id"])` — reads fine in review and only explodes
 * under load, once per request, in every worker, inside a structured clone posted at ~1 Hz.
 * Killing a run mid-flight over a reporting mistake would be the wrong trade, so the recording is
 * refused and the refusal counted, the same rule this tool applies to dropped requests and clamped
 * samples. A refusal nobody counts is a silent hole in the numbers.
 *
 * **Config-derived identifiers throw.** A scenario name comes from the scenario list in the user's
 * TS config, so breaching a bound there is deterministic: the same config fails the same way every
 * run, at startup, before any load is generated. Failing loudly is both possible and kinder than
 * silently dropping a scenario the user asked for — the report would otherwise be missing a whole
 * section with only a counter to explain it. (PR 5's config loader should reject these earlier
 * still, with a message pointing at the file; this is the backstop, not the front door.)
 *
 * An empty name throws under either rule: it is a bug in the caller, never a value.
 */
export const MAX_METRIC_NAME_LENGTH = 120;

/**
 * Per registry, per kind — **not** per run. A histogram costs ~68 KiB of buckets, so distributions
 * are capped far tighter than tallies: 32 histograms + 32 trends bounds one scenario's buckets at
 * ~4.4 MB per worker, while 512 counters and 512 checks cost a few tens of KB.
 *
 * Merging is deliberately not re-capped, so the caps bound *what one worker holds and posts*, not
 * what the aggregate contains: eight at-cap workers with disjoint counter names merge to 4096
 * entries with `refusedCount: 0`. That is still bounded — workers × cap — but it is a larger bound
 * than these constants imply on their own. Re-capping at merge would mean discarding data that was
 * already measured and paid for, and deciding *which* worker's names to drop.
 */
export const MAX_DISTINCT_DISTRIBUTIONS = 32;
export const MAX_DISTINCT_TALLIES = 512;

/** Scenarios are few by nature; a config generating more than this is a bug worth surfacing. */
export const MAX_DISTINCT_SCENARIOS = 64;

/**
 * Checks a single scenario may declare.
 *
 * Each one reserves a counter slot for its broken tally, out of the same `MAX_DISTINCT_TALLIES`
 * budget the user's own counters draw on. Unbounded, 400 declared checks would silently leave a
 * config 103 counter slots and then fail its run with a message about counters-per-seat. 64 is
 * generous for named claims about one scenario and leaves the budget recognisably intact.
 */
export const MAX_CHECKS_PER_SCENARIO = 64;

/**
 * Keys one declared counter may hold, before its implicit `other`.
 *
 * Each key is a reserved slot out of `MAX_DISTINCT_TALLIES`, so this is a per-counter guard on top
 * of the whole-scenario budget `assert-shape.ts` computes. 64 is generous for a dimension anyone
 * can read off a report — a key space bigger than that is a dimension nobody is going to skim.
 */
export const MAX_KEYS_PER_COUNTER = 64;

/**
 * Counter slots that must stay free for a scenario's own `record.count(...)`.
 *
 * Expressed as a floor on what is left rather than a ceiling on declarations, because that is the
 * property actually wanted — and because "declarations may use half" overstates what a reader gets:
 * with 256 declared, 64 broken-check slots and the engine's own, only 181 remain, not 256. A rule
 * whose message has to fudge its own arithmetic is a rule stated wrong.
 *
 * Without a floor, a config declaring exactly the budget starts, has every plain `count` refused,
 * and is told at the end of the run to use fewer names — the diagnosis-without-a-remedy declared
 * key spaces exist to remove, aimed at someone who bounded their cardinality perfectly.
 */
export const MIN_FREE_TALLIES_PER_SCENARIO = 128;

export const assertMetricName = (name: string, kind: string): void => {
  if (name.length === 0) {
    throw new RangeError(`A ${kind} name must not be empty`);
  }
};

/**
 * Full validation for a config-derived identifier: non-empty, bounded length, bounded cardinality.
 * Throws rather than refusing — see the rule above.
 */
export const assertScenarioName = (known: ReadonlyMap<string, unknown>, name: string): void => {
  assertMetricName(name, "scenario");
  if (name.length > MAX_METRIC_NAME_LENGTH) {
    throw new RangeError(
      `A scenario name must be at most ${String(MAX_METRIC_NAME_LENGTH)} characters, got ${String(name.length)}`,
    );
  }
  if (!known.has(name) && known.size >= MAX_DISTINCT_SCENARIOS) {
    throw new RangeError(
      `A run may hold at most ${String(MAX_DISTINCT_SCENARIOS)} scenarios; "${name}" would be one too many`,
    );
  }
};

/** Whether `name` may still be recorded: already known, or short enough and there is room left. */
export const admitsMetricName = (
  known: ReadonlyMap<string, unknown>,
  name: string,
  limit: number,
): boolean => name.length <= MAX_METRIC_NAME_LENGTH && (known.has(name) || known.size < limit);

export const assertSample = (value: number, subject: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${subject} expects a finite, non-negative value, got ${String(value)}`);
  }
};

export const assertTally = (value: number, subject: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${subject} must be a non-negative safe integer, got ${String(value)}`);
  }
};

export const assertPercentileRank = (rank: number): void => {
  if (!Number.isFinite(rank) || rank < 0 || rank > 100) {
    throw new RangeError(`A percentile rank must be between 0 and 100, got ${String(rank)}`);
  }
};

import { duration, ms, orderedKeys, plain, rate } from "../report/format.ts";
import { shortfallParts } from "../report/shortfall.ts";
import type { LatencySummary, RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";
import type { Verdict } from "./thresholds.ts";

/**
 * What a finished run says on a terminal.
 *
 * Plain text, no colour, no cursor tricks: this is the output a CI log keeps, and the live
 * dashboard is a separate consumer of the same summary (D1-07). Every number that could flatter the
 * target is printed next to the one that contradicts it — requested beside achieved, dispatched
 * beside dropped — because a reader should not have to know which field to be suspicious of.
 *
 * Rounding happens here and only here: `RunSummary` keeps full precision because threshold
 * predicates read it. Every rounding in this file goes **away** from flattering the target.
 */

/**
 * The caveat that has to travel with a clamped distribution.
 *
 * Per row, not per scenario: `scheduledLatency` is ≥ `latency` by construction, so it reaches the
 * histogram ceiling **first** — warning only about the send-side distribution would stay silent on
 * exactly the coordinated-omission run D1-01 was written for.
 */
const lowerBoundNote = (label: string, summary: LatencySummary | undefined): string | undefined =>
  summary?.isLowerBound === true
    ? `    ⚠ ${label}: ${String(summary.overflowCount)} samples exceeded the histogram ceiling — those percentiles are lower bounds, not measurements`
    : undefined;

const percentiles = (label: string, summary: LatencySummary | undefined): string =>
  `    ${label}  p50 ${ms(summary?.p50Ms)} · p95 ${ms(summary?.p95Ms)} · p99 ${ms(summary?.p99Ms)}`;

const scenarioLines = (scenario: ScenarioRunSummary): readonly string[] => {
  const lines = [
    `  ${plain(scenario.name)}`,
    `    requests    ${String(scenario.scheduledCount)} scheduled · ${String(scenario.dispatchedCount)} sent · ${String(scenario.responseCount)} answered`,
  ];

  // Only shown when non-zero, so a clean run reads clean — but never summarised away, because the
  // achieved rate below is only interpretable next to what did not happen.
  // `dispatched + dropped + notBuilt + impure === scheduled` is the identity this line keeps true.
  // Without it a config whose `request()` threw showed a halved achieved rate with no cause
  // anywhere on the page — the shortfall said "none".
  const shortfalls = shortfallParts(scenario);
  if (shortfalls.length > 0) {
    lines.push(`    shortfall   ${shortfalls.join(" · ")}`);
  }

  // A burst asks for a *count*, not a rate, so both sides are undefined and the row would read
  // `— · —` — indistinguishable from "not known". Saying why is better than printing dashes.
  if (scenario.requestedRatePerSecond === undefined) {
    lines.push(`    rate        n/a — a burst asks for a count, not a rate`);
  } else {
    lines.push(
      `    rate        ${rate(scenario.requestedRatePerSecond, "requested")} requested · ${rate(scenario.achievedRatePerSecond, "achieved")} achieved`,
    );
  }

  lines.push(percentiles("latency   ", scenario.latencyMs));
  lines.push(percentiles("as queued ", scenario.scheduledLatencyMs));

  // The generator's own backlog, shown only when it is real. If this is large the run says more
  // about stampede's machine than about the target, and a reader has to be told rather than left
  // to infer it from a gap between two latency rows.
  const lagMs = scenario.scheduleLagMs?.maxMs;
  if (lagMs !== undefined && lagMs >= 1) {
    lines.push(`    backlog     ${ms(lagMs)} max — the generator's own lateness, not the target's`);
  }

  lines.push(
    ...[
      lowerBoundNote("latency", scenario.latencyMs),
      lowerBoundNote("as queued", scenario.scheduledLatencyMs),
    ].filter((note): note is string => note !== undefined),
  );

  // Checks are the reason this tool exists, so they print even when they all passed — a run that
  // asserted something and a run that asserted nothing must not look the same.
  for (const [name, tally] of Object.entries(scenario.checks)) {
    // Three states, and broken outranks failed: a check that threw on some responses and returned
    // `false` on others is a check nobody should be reading a verdict from yet (D2-04).
    const verdict =
      tally.broken > 0
        ? `BROKEN ${String(tally.broken)}`
        : tally.failed === 0
          ? "PASS"
          : `FAIL ${String(tally.failed)}/${String(tally.passed + tally.failed)}`;
    lines.push(`    check       ${verdict}  ${plain(name)}`);
  }
  for (const [name, value] of Object.entries(scenario.counters)) {
    lines.push(`    counter     ${plain(name)} = ${String(value)}`);
  }
  for (const [name, keys] of Object.entries(scenario.keyedCounters)) {
    // One line per counter, keys inline: a declared key space is a *dimension*, and splitting it
    // across N rows would bury the comparison between keys that is the only reason to declare it.
    // `keyed` rather than `counter` so a reader can tell which map a number came from.
    const parts = orderedKeys(keys).map((key) => `${plain(key)} ${String(keys[key] ?? 0)}`);
    lines.push(`    keyed       ${plain(name)}  ${parts.join(" · ")}`);
  }
  for (const [name, trend] of Object.entries(scenario.trends)) {
    lines.push(
      `    recorded    ${plain(name)}  p50 ${ms(trend.p50Ms)} · p99 ${ms(trend.p99Ms)} · max ${ms(trend.maxMs)}`,
    );
  }
  if (scenario.brokenObservations > 0) {
    lines.push(
      `    ⚠ ${String(scenario.brokenObservations)} broken observations — a check or onResponse threw, returned a non-boolean, or named a metric the scenario cannot write`,
    );
  }
  if (scenario.refusedRecordings > 0) {
    lines.push(
      `    ⚠ ${String(scenario.refusedRecordings)} recordings refused — more distinct metric names than a cap allows, so some counters or distributions are missing entirely, not merely undercounted`,
    );
  }

  return lines;
};

export const renderSummary = (summary: RunSummary): string =>
  [
    "",
    // "peak in flight" is a sum of independent per-thread maxima, so it is an upper bound rather
    // than something anyone observed — the threads peaked whenever they peaked. Said, not implied.
    `run finished in ${duration(summary.elapsedMs)} · peak in flight ≤ ${String(summary.maxObservedInFlight)} (sum of per-thread peaks)`,
    "",
    ...summary.scenarios.flatMap((scenario) => [...scenarioLines(scenario), ""]),
  ].join("\n");

/**
 * @param runFailed whether anything else already went wrong, which changes what "no thresholds"
 * means. A run that failed in `teardown` now reaches here with an *empty* verdict rather than none,
 * and "nothing was asserted about this run" printed one line above "teardown() failed — double
 * sell: 2 sold" is the same false reassurance the report refuses to publish.
 */
export const renderVerdict = (verdict: Verdict, runFailed: boolean): string => {
  if (verdict.results.length === 0) {
    return runFailed ? "" : "no thresholds declared — nothing was asserted about this run\n";
  }
  const lines = verdict.results.map((result) => {
    if (result.error !== undefined) {
      // `plain` on both: the name is config-derived, but a predicate's message routinely carries
      // target text — `throw new Error(await res.text())` in a teardown is the obvious case — and
      // this string goes to a terminal and a CI log.
      return `  BROKEN  ${plain(result.name)} — ${plain(result.error)}`;
    }
    return `  ${result.held ? "PASS  " : "FAIL  "}  ${plain(result.name)}`;
  });
  return ["thresholds", ...lines, ""].join("\n");
};

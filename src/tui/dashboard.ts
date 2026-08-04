import { duration, ms, plain, rate } from "../report/format.ts";
import type { RunSummary, ScenarioRunSummary } from "../engine/run-summary.ts";

/**
 * The live dashboard — the brief's demo hook, and the only thing in the repo that draws.
 *
 * A consumer of the engine's output, never the other way round (D1-07): it is handed a
 * `RunSummary` and knows nothing about workers, schedules or transports. Swapping it for a
 * different renderer costs one call site.
 *
 * No dependencies and no full-screen takeover. A load run belongs in a terminal that still has the
 * user's scrollback in it, so this redraws **in place** with cursor moves rather than switching to
 * an alternate screen — and everything it draws is also what the final summary prints, so a run
 * watched live and a run read from a CI log tell the same story.
 */

const CSI = "[";
/** Up N lines, then clear from the cursor to the end of the screen. */
const moveUpAndClear = (lines: number): string =>
  lines === 0 ? "" : `${CSI}${String(lines)}F${CSI}J`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

/**
 * One line, at most `width` code points, with anything that would add a row removed.
 *
 * Scenario names come from user config, and the whole in-place redraw rests on the frame's physical
 * row count equalling its line count. A name containing a newline adds a row the redraw does not
 * know about, and one line of debris climbs the terminal on every frame. Slicing by code point
 * rather than code unit also keeps an emoji from being cut into a lone surrogate.
 */
const truncate = (line: string, width: number): string => {
  // `plain` rather than a second regex here: two answers to "what is a control character" in one
  // repo is one too many, and this file's copy was the weaker of them (it missed the C1 range).
  const printable = plain(line);
  // Spreading a string iterates code points, which is the point: slicing by code unit can cut an
  // emoji in half and emit a lone surrogate to the terminal. Grapheme clusters would be better
  // still, but `Intl.Segmenter` is a dependency-free improvement for another day and the failure it
  // would fix (a combining mark separated from its base) does not break the redraw invariant.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...printable].slice(0, Math.max(1, width)).join("");
};

/** A fixed-width bar over instants dealt with — dispatched plus dropped — against scheduled. */
const bar = (fraction: number, width = 24): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

/**
 * The rate achieved **so far**, which is not the one on `RunSummary`.
 *
 * `achievedRatePerSecond` divides dispatches by the profile's whole configured window, which is
 * right exactly once — at the end. Used mid-run it divides a partial numerator by a full
 * denominator, so a run issuing exactly its requested rate displays as a two-thirds shortfall for
 * its entire duration: at t+1s of a 3s run, 200 of 600 requests read as "66/s achieved" against
 * "200/s asked". The line that exists to tell "keeping up" from "falling behind" would say the same
 * thing in both cases.
 */
const achievedSoFar = (dispatched: number, elapsedMs: number): number | undefined =>
  elapsedMs <= 0 ? undefined : (dispatched * 1000) / elapsedMs;

const scenarioLines = (scenario: ScenarioRunSummary, elapsedMs: number): readonly string[] => {
  // `dropped` and `not built` count too: both are schedule instants that have been dealt with, and
  // a bar that ignored them would crawl while the run was in fact racing to its end.
  const done =
    scenario.dispatchedCount +
    scenario.droppedCount +
    scenario.requestErrorCount +
    scenario.impureRequestCount;
  const fraction = scenario.scheduledCount === 0 ? 0 : done / scenario.scheduledCount;

  const lines = [
    `  ${scenario.name}`,
    `    ${bar(fraction)} ${String(done)}/${String(scenario.scheduledCount)} · ${String(scenario.responseCount)} answered`,
  ];

  // Shown the instant it is non-zero. A dashboard that only reveals drops at the end lets someone
  // watch a run they think is healthy for twenty minutes.
  const shortfalls = [
    scenario.droppedCount > 0 ? `${String(scenario.droppedCount)} dropped` : undefined,
    scenario.requestErrorCount > 0 ? `${String(scenario.requestErrorCount)} not built` : undefined,
    scenario.impureRequestCount > 0
      ? `${String(scenario.impureRequestCount)} impure request()`
      : undefined,
    scenario.errorCount > 0 ? `${String(scenario.errorCount)} failed` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (shortfalls.length > 0) {
    lines.push(`    ⚠ ${shortfalls.join(" · ")}`);
  }

  if (scenario.requestedRatePerSecond !== undefined) {
    lines.push(
      `    rate ${rate(scenario.requestedRatePerSecond, "requested")} asked · ${rate(achievedSoFar(scenario.dispatchedCount, elapsedMs), "achieved")} so far`,
    );
  }
  lines.push(
    `    p50 ${ms(scenario.latencyMs?.p50Ms)} · p99 ${ms(scenario.latencyMs?.p99Ms)} · queued p99 ${ms(scenario.scheduledLatencyMs?.p99Ms)}`,
  );

  // Only the failing ones, and only while they are failing. Waiting for the summary to reveal that
  // every response has been failing `noDoubleSell` for eight minutes is the same mistake as hiding
  // drops, which this file already refuses (D2-05).
  const failing = Object.entries(scenario.checks).filter(([, tally]) => tally.failed > 0);
  if (failing.length > 0) {
    lines.push(
      `    ✗ ${failing.map(([name, tally]) => `${name} ${String(tally.failed)}`).join(" · ")}`,
    );
  }
  // Named, not just counted. "3 broken observations" at minute one of a twenty-minute run leaves
  // the reader with nothing to fix; the check's name is the fix.
  const broken = Object.entries(scenario.checks).filter(([, tally]) => tally.broken > 0);
  if (broken.length > 0) {
    lines.push(
      `    ⚠ broken: ${broken.map(([name, tally]) => `${name} ${String(tally.broken)}`).join(" · ")}`,
    );
  } else if (scenario.brokenObservations > 0) {
    // `onResponse` threw, or a metric the scenario cannot write was named — no check to blame.
    lines.push(`    ⚠ ${String(scenario.brokenObservations)} broken observations`);
  }
  // Live, for the same reason drops are: this now *fails the run*, and finding out at the end that
  // the last nineteen minutes were recording into a full map is the silence D2-05 refuses.
  if (scenario.refusedRecordings > 0) {
    lines.push(`    ⚠ ${String(scenario.refusedRecordings)} recordings refused — too many names`);
  }

  return lines;
};

export const frameFor = (summary: RunSummary): readonly string[] => [
  `stampede · ${duration(summary.elapsedMs)} · in flight ≤ ${String(summary.maxObservedInFlight)}`,
  ...summary.scenarios.flatMap((scenario) => scenarioLines(scenario, summary.elapsedMs)),
];

export interface Dashboard {
  readonly update: (summary: RunSummary) => void;
  /** Clears the live frame so the final summary is not printed underneath a stale one. */
  readonly stop: () => void;
}

export interface DashboardOptions {
  readonly write: (text: string) => void;
  /**
   * How many columns are available; frames are truncated rather than wrapped.
   *
   * Typed `number` by Node but not always one: a pty with no window size reports `0`, and some
   * report `undefined`. Both slipped through and drew a garbage frame — one character per row, or
   * five blank rows — for the whole run, so the value is floored rather than trusted.
   */
  readonly columns: number | undefined;
}

const MIN_COLUMNS = 40;
const DEFAULT_COLUMNS = 80;

/**
 * Draws frames in place.
 *
 * Truncates rather than wraps: a wrapped line occupies two rows, so the next redraw would move up
 * by fewer rows than it printed and leave debris climbing the terminal. Truncation keeps the frame
 * height equal to the line count, which is the whole basis of drawing in place.
 */
export const createDashboard = (options: DashboardOptions): Dashboard => {
  let drawnLines = 0;
  options.write(HIDE_CURSOR);

  const clear = (): void => {
    options.write(moveUpAndClear(drawnLines));
    drawnLines = 0;
  };

  return {
    update: (summary) => {
      const width = Math.max(
        MIN_COLUMNS,
        Number.isFinite(options.columns) && (options.columns ?? 0) > 0
          ? (options.columns ?? DEFAULT_COLUMNS)
          : DEFAULT_COLUMNS,
      );
      const lines = frameFor(summary).map((line) => truncate(line, width - 1));
      clear();
      options.write(`${lines.join("\n")}\n`);
      drawnLines = lines.length;
    },
    stop: () => {
      clear();
      options.write(SHOW_CURSOR);
    },
  };
};

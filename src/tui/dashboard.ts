import { duration, ms, rate } from "../report/format.ts";
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

/** A fixed-width bar. Progress is the honest kind: dispatched against scheduled, nothing smoothed. */
const bar = (fraction: number, width = 24): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const scenarioLines = (scenario: ScenarioRunSummary): readonly string[] => {
  const done = scenario.dispatchedCount + scenario.droppedCount;
  const fraction = scenario.scheduledCount === 0 ? 0 : done / scenario.scheduledCount;

  const lines = [
    `  ${scenario.name}`,
    `    ${bar(fraction)} ${String(done)}/${String(scenario.scheduledCount)} · ${String(scenario.responseCount)} answered`,
  ];

  // Shown the instant it is non-zero. A dashboard that only reveals drops at the end lets someone
  // watch a run they think is healthy for twenty minutes.
  const shortfalls = [
    scenario.droppedCount > 0 ? `${String(scenario.droppedCount)} dropped` : undefined,
    scenario.errorCount > 0 ? `${String(scenario.errorCount)} failed` : undefined,
  ].filter((part): part is string => part !== undefined);
  if (shortfalls.length > 0) {
    lines.push(`    ⚠ ${shortfalls.join(" · ")}`);
  }

  if (scenario.requestedRatePerSecond !== undefined) {
    lines.push(
      `    rate ${rate(scenario.requestedRatePerSecond, "requested")} asked · ${rate(scenario.achievedRatePerSecond, "achieved")} achieved`,
    );
  }
  lines.push(
    `    p50 ${ms(scenario.latencyMs?.p50Ms)} · p99 ${ms(scenario.latencyMs?.p99Ms)} · queued p99 ${ms(scenario.scheduledLatencyMs?.p99Ms)}`,
  );

  return lines;
};

export const frameFor = (summary: RunSummary): readonly string[] => [
  `stampede · ${duration(summary.elapsedMs)} · in flight ≤ ${String(summary.maxObservedInFlight)}`,
  ...summary.scenarios.flatMap(scenarioLines),
];

export interface Dashboard {
  readonly update: (summary: RunSummary) => void;
  /** Clears the live frame so the final summary is not printed underneath a stale one. */
  readonly stop: () => void;
}

export interface DashboardOptions {
  readonly write: (text: string) => void;
  /** How many columns are available; frames are truncated rather than wrapped. */
  readonly columns: number;
}

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
      const lines = frameFor(summary).map((line) =>
        line.slice(0, Math.max(1, options.columns - 1)),
      );
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

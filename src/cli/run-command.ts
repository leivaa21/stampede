import path from "node:path";
import { loadConfig } from "../config/load.ts";
import { drainTimeoutMsFor, maxInFlightFor, workerCountFor } from "../config/to-run.ts";
import type { RunSummary } from "../engine/run-summary.ts";
import { runPool } from "../engine/worker-pool.ts";
import {
  evaluateThresholds,
  findBrokenObservations,
  findImpureRequests,
  findUnbuiltMajority,
  findRefusedRecordings,
  findUnmeasuredScenario,
  type Verdict,
} from "./thresholds.ts";

/**
 * One `stampede run`, from a config path to a verdict.
 *
 * The order here is the milestone's whole argument: **setup, storm, teardown, then judge.** The
 * invariant open-ticket cares about is not "did any request 409" — it is "after five hundred buyers
 * fought over one seat, is exactly one seat sold". That can only be asked once the storm is over,
 * which is why `teardown` runs before any threshold and why its failure is a violation rather than
 * a crash.
 */

export const ExitCode = {
  Ok: 0,
  ThresholdViolated: 1,
  RunFailed: 2,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface RunReport {
  readonly exitCode: ExitCodeValue;
  readonly summary: RunSummary | undefined;
  readonly verdict: Verdict | undefined;
  /**
   * Why the run did not come out clean — **one reason per entry**, each already phrased for a
   * human, empty when nothing went wrong.
   *
   * A list rather than a joined string because every surface formats it differently and only the
   * producer knows where one reason ends. Joined with `\n` it met the report's table-cell escaping,
   * which flattens newlines, and four reasons became a single 700-character paragraph with the
   * double sell buried at the end of a sentence about cardinality caps.
   */
  readonly failures: readonly string[];
  readonly supersededSnapshots: number;
  /** What the run was actually configured as — the report's provenance. */
  readonly workerCount: number;
  readonly maxInFlight: number;
  readonly drainTimeoutMs: number;
}

export interface RunOptions {
  readonly configPath: string;
  readonly workers?: number | undefined;
  /** Called with a merged summary while the run is in flight, for a live view. */
  readonly onProgress?: (summary: RunSummary) => void;
}

interface RunSettings {
  readonly workerCount: number;
  readonly maxInFlight: number;
  readonly drainTimeoutMs: number;
}

/** Before the config is readable there are no settings to report, only the failure. */
const UNKNOWN_SETTINGS: RunSettings = { workerCount: 0, maxInFlight: 0, drainTimeoutMs: 0 };

const failed = (failure: string, settings: RunSettings): RunReport => ({
  exitCode: ExitCode.RunFailed,
  summary: undefined,
  verdict: undefined,
  failures: [failure],
  supersededSnapshots: 0,
  ...settings,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runFromConfig = async (options: RunOptions): Promise<RunReport> => {
  const configPath = path.resolve(options.configPath);

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error: unknown) {
    return failed(messageOf(error), UNKNOWN_SETTINGS);
  }
  const settings: RunSettings = {
    workerCount: options.workers ?? workerCountFor(config),
    maxInFlight: maxInFlightFor(config),
    drainTimeoutMs: drainTimeoutMsFor(config),
  };

  // `setup()` runs **once, here, on the main thread** — never in a worker, and never per virtual
  // user. Its return value is data that every worker receives by structured clone (D1-04), which is
  // why a client belongs inside the scenario and an id belongs in the state.
  let setupState: unknown;
  try {
    setupState = await config.setup?.();
  } catch (error: unknown) {
    return failed(`setup() failed: ${messageOf(error)}`, settings);
  }

  let summary: RunSummary;
  let supersededSnapshots: number;
  try {
    const outcome = await runPool({
      modulePath: configPath,
      workerCount: settings.workerCount,
      maxInFlight: settings.maxInFlight,
      drainTimeoutMs: settings.drainTimeoutMs,
      setupState,
      onProgress: options.onProgress,
    });
    summary = outcome.summary;
    supersededSnapshots = outcome.supersededSnapshots;
  } catch (error: unknown) {
    // The load itself could not be generated. `teardown` still runs below on the happy path only:
    // there is deliberately no cleanup-on-failure here, because a teardown written to *assert* an
    // invariant would report a confusing failure about a run that never happened.
    return failed(messageOf(error), settings);
  }

  // Before any threshold: a scenario that measured nothing cannot be judged, only reported broken.
  const unmeasured = findUnmeasuredScenario(summary);
  if (unmeasured !== undefined) {
    return { ...failed(unmeasured, settings), summary, supersededSnapshots };
  }

  // Collected here, reported after the thresholds and the teardown. These are runs whose
  // *measurements* are real and whose *claims* are not, so unlike an unmeasured scenario there is a
  // percentile table worth printing — and returning early would cost the reader the specific half
  // of the story, the same trade the teardown path below already refuses.
  const runFailures = [
    findBrokenObservations(summary),
    findRefusedRecordings(summary),
    findImpureRequests(summary),
    findUnbuiltMajority(summary),
  ].filter((failure): failure is string => failure !== undefined);

  // The invariant is proven *after* the storm — this is the line D1-06 exists for. A throw here is
  // a violated claim, not a crashed tool, so it lands on exit 1 with the rest of them.
  let teardownFailure: string | undefined;
  if (config.teardown !== undefined) {
    try {
      await config.teardown(setupState);
    } catch (error: unknown) {
      teardownFailure = `teardown() failed — the invariant did not hold after the run: ${messageOf(error)}`;
    }
  }

  // Evaluated even when teardown failed. Returning early bought nothing and cost the reader the
  // more specific half: "the seat sold twice" is the symptom, and "`exactly one buyer wins` —
  // reserved201 was 500" is the claim that names it.
  const verdict = evaluateThresholds(config.thresholds ?? [], summary);
  // Every *kind* of reason the run did not come out clean, never only the first: one failure
  // hiding behind another is how a second bug survives a fix for the first. (Each finder still
  // names one scenario — the first offending one — which is enough to act on.)
  //
  // `teardownFailure` belongs in here rather than only in the exit code below. Moving the broken
  // observations check after `teardown` meant teardown now *runs* on that path, and a config whose
  // check has a typo *and* whose seat sold twice would otherwise report only the typo — losing the
  // double sell, which is the thing the tool exists to find.
  const failures = [
    ...(verdict.broken.length > 0
      ? [`a threshold predicate threw: ${verdict.broken.join(", ")}`]
      : []),
    ...runFailures,
    ...(teardownFailure !== undefined ? [teardownFailure] : []),
  ];
  // Exit 2 outranks exit 1: a run whose claims are broken cannot be trusted to have judged the
  // target at all, so "the run failed" is the honest verdict even when a threshold also fell.
  if (verdict.broken.length > 0 || runFailures.length > 0) {
    return {
      exitCode: ExitCode.RunFailed,
      summary,
      verdict,
      failures,
      supersededSnapshots,
      ...settings,
    };
  }

  return {
    exitCode:
      failures.length > 0 || verdict.violated.length > 0 ? ExitCode.ThresholdViolated : ExitCode.Ok,
    summary,
    verdict,
    failures,
    supersededSnapshots,
    ...settings,
  };
};

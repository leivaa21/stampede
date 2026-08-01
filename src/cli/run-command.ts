import path from "node:path";
import { loadConfig } from "../config/load.ts";
import { drainTimeoutMsFor, maxInFlightFor, workerCountFor } from "../config/to-run.ts";
import type { RunSummary } from "../engine/run-summary.ts";
import { runPool } from "../engine/worker-pool.ts";
import { evaluateThresholds, findUnmeasuredScenario, type Verdict } from "./thresholds.ts";

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
  /** Why the run failed, when it did. Already phrased for a human. */
  readonly failure: string | undefined;
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
  failure,
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

  // The invariant is proven *after* the storm — this is the line D1-06 exists for. A throw here is
  // a violated claim, not a crashed tool, so it lands on exit 1 with the rest of them.
  if (config.teardown !== undefined) {
    try {
      await config.teardown(setupState);
    } catch (error: unknown) {
      return {
        exitCode: ExitCode.ThresholdViolated,
        summary,
        verdict: undefined,
        failure: `teardown() failed — the invariant did not hold after the run: ${messageOf(error)}`,
        supersededSnapshots,
        ...settings,
      };
    }
  }

  const verdict = evaluateThresholds(config.thresholds ?? [], summary);
  if (verdict.broken.length > 0) {
    return {
      exitCode: ExitCode.RunFailed,
      summary,
      verdict,
      failure: `a threshold predicate threw: ${verdict.broken.join(", ")}`,
      supersededSnapshots,
      ...settings,
    };
  }

  return {
    exitCode: verdict.violated.length > 0 ? ExitCode.ThresholdViolated : ExitCode.Ok,
    summary,
    verdict,
    failure: undefined,
    supersededSnapshots,
    ...settings,
  };
};

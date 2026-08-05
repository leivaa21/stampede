/**
 * The open-loop load engine: arrival profiles, the dispatch loop, and what the run has to admit to.
 *
 * Imports no UI, ever — the TUI and the markdown reporter are consumers of what comes out of here,
 * never the other way round (D1-07, enforced by an ESLint boundary rule).
 *
 * `arrival-profiles.ts` and `schedule.ts` are pure: no clock, no I/O, testable without a fake
 * anything. `dispatcher.ts` is the only file that touches time, and it does so through the ports
 * in `ports.ts` — which is what makes "the reported latency includes the generator's own backlog"
 * an assertion rather than a claim.
 */

export type {
  ArrivalProfile,
  BurstOptions,
  ConstantRateOptions,
  RampOptions,
} from "./arrival-profiles.ts";
export { burst, constantRate, ramp, stages } from "./arrival-profiles.ts";
export { LiveProgress, runDispatch, type RunOutcome, type RunPorts } from "./dispatcher.ts";
export { httpTransport, type HttpRequestSpec } from "./http-transport.ts";
export { EngineMetric } from "./metric-names.ts";
export type { Clock, Transport, TransportResponse } from "./ports.ts";
export {
  DEFAULT_DRAIN_TIMEOUT_MS,
  ImpureRequestError,
  type RunSpec,
  type Scenario,
} from "./run-spec.ts";
export type { RunSummary, ScenarioRunSummary } from "./run-summary.ts";
export { mergedSchedule, type ScheduledDispatch, type ScheduledScenario } from "./schedule.ts";
export { shardMaxInFlight, shardProfile, shardScenarios, type Shard } from "./schedule-split.ts";
export { systemClock } from "./system-clock.ts";
export {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  mergeProgress,
  runPool,
  type PoolRunOutcome,
  type PoolRunSpec,
} from "./worker-pool.ts";

import { MetricsRegistry, type ScenarioMetrics } from "../metrics/index.ts";
import { InFlight } from "./in-flight.ts";
import { recordLatencies } from "./latency.ts";
import { EngineMetric } from "./metric-names.ts";
import type { Clock, Transport } from "./ports.ts";
import {
  assertRunSpec,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type RunSpec,
  type Scenario,
} from "./run-spec.ts";
import { summariseRun, type RunSummary } from "./run-summary.ts";
import { mergedSchedule } from "./schedule.ts";

interface ScenarioState<TRequest> extends Scenario<TRequest> {
  readonly metrics: ScenarioMetrics;
  lastDispatchElapsedMs: number | undefined;
  pendingCount: number;
}

export interface RunPorts<TRequest> {
  readonly clock: Clock;
  readonly transport: Transport<TRequest>;
  /** Defaults to a fresh registry. A worker passes its own, which is the one it snapshots (D1-03). */
  readonly metrics?: MetricsRegistry;
}

export interface RunOutcome {
  readonly summary: RunSummary;
  /** The registry everything was recorded into — the worker's side of the merge protocol. */
  readonly metrics: MetricsRegistry;
}

/**
 * Runs one open-loop dispatch loop to completion and reports what really happened.
 *
 * **Open-loop**: the schedule is consumed regardless of whether earlier responses have come back.
 * Nothing in this loop awaits a response, so a target that slows down cannot make the generator
 * send less — which is exactly what a closed-loop generator does, and why its p99 flatters a
 * struggling system (D1-01).
 *
 * **Timer granularity**, and the honest limits of the approach: `setTimeout` resolves on a ~1 ms
 * tick and drifts, so a loop that slept once per request would cap out near a thousand requests a
 * second and fall further behind on every wait. Instead the loop **dispatches everything already
 * due, then sleeps to the next instant** — a late wake-up then costs lateness rather than
 * requests. What it never does is move an instant or quietly lower a rate: if a single thread
 * cannot issue requests as fast as the profile asks (the ceiling depends on the transport, and
 * PR 4's worker pool raises it rather than changing what happens at it), the requests still go
 * out, late, in a burst when the loop catches up, and every millisecond of that lateness lands in
 * `scheduledLatency` and in the schedule-lag trend where a reader can see it.
 *
 * The due set is frozen at each batch's first clock reading, so a batch cannot chase its own tail
 * while it is going out; instants that come due mid-batch go out one event-loop turn later.
 */
export const runDispatch = async <TRequest>(
  spec: RunSpec<TRequest>,
  ports: RunPorts<TRequest>,
): Promise<RunOutcome> => {
  assertRunSpec(spec);

  const { clock, transport } = ports;
  const metrics = ports.metrics ?? new MetricsRegistry();
  // Namespaces are created up front, so a scenario name the metrics registry refuses fails the
  // run before any load is generated rather than on its first response.
  const states: ScenarioState<TRequest>[] = spec.scenarios.map((scenario) => ({
    ...scenario,
    metrics: metrics.scenario(scenario.name),
    lastDispatchElapsedMs: undefined,
    pendingCount: 0,
  }));

  const inFlight = new InFlight();
  const startedAtMs = clock.now();
  let recordingResponses = true;

  const dispatch = (state: ScenarioState<TRequest>, instantMs: number): void => {
    // The cap is the price of open-loop dispatch: against a target that has stopped answering, the
    // schedule keeps producing instants and memory is otherwise unbounded. Dropped *and* counted.
    if (inFlight.count >= spec.maxInFlight) {
      state.metrics.counters.inc(EngineMetric.dropped);
      return;
    }

    const scheduledAtMs = startedAtMs + instantMs;
    const sentAtMs = clock.now();
    state.lastDispatchElapsedMs = sentAtMs - startedAtMs;
    state.pendingCount += 1;
    state.metrics.counters.inc(EngineMetric.dispatched);
    state.metrics.trend(EngineMetric.scheduleLag).recordMs(Math.max(0, sentAtMs - scheduledAtMs));

    inFlight.track(
      transport.send(state.request).then(
        (): void => {
          state.pendingCount -= 1;
          if (recordingResponses) {
            state.metrics.counters.inc(EngineMetric.responses);
            recordLatencies(state.metrics, { scheduledAtMs, sentAtMs, doneAtMs: clock.now() });
          }
        },
        (): void => {
          state.pendingCount -= 1;
          // A transport-level failure is counted, never timed: an instant connection refusal
          // recorded as a 0.1 ms latency is the most flattering p99 a broken target could produce.
          if (recordingResponses) {
            state.metrics.counters.inc(EngineMetric.errors);
          }
        },
      ),
    );
  };

  const schedule = mergedSchedule(states);
  let next = schedule.next();
  while (next.done !== true) {
    const elapsedMs = clock.now() - startedAtMs;
    if (next.value.instantMs > elapsedMs) {
      await clock.sleep(next.value.instantMs - elapsedMs);
      continue;
    }
    while (next.done !== true && next.value.instantMs <= elapsedMs) {
      dispatch(next.value.scenario, next.value.instantMs);
      next = schedule.next();
    }
    // One event-loop turn per batch, so responses can land and in-flight can drain. Without it a
    // run that has fallen behind would spin through its backlog with the cap full of requests the
    // target already answered. `sleep(0)` is a `setImmediate`, not a timer — see `system-clock.ts`.
    await clock.sleep(0);
  }

  await inFlight.drain(clock, spec.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  // Nothing is awaited between the drain returning and this line, so `pendingCount` cannot move
  // while the abandoned tally is taken. Responses that land afterwards are not recorded: the run
  // has already published its numbers, and a percentile that keeps moving after the report was
  // written is worse than a sample that is honestly missing.
  recordingResponses = false;
  for (const state of states) {
    if (state.pendingCount > 0) {
      state.metrics.counters.inc(EngineMetric.abandoned, state.pendingCount);
    }
  }

  return {
    summary: summariseRun(
      {
        elapsedMs: clock.now() - startedAtMs,
        maxObservedInFlight: inFlight.maxObserved,
        scenarios: states.map((state) => ({
          name: state.name,
          scheduledCount: state.profile.count,
          requestedDurationMs: state.profile.durationMs,
          lastDispatchElapsedMs: state.lastDispatchElapsedMs,
        })),
      },
      metrics,
    ),
    metrics,
  };
};

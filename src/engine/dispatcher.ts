import { MetricsRegistry, type ScenarioMetrics } from "../metrics/index.ts";
import { InFlight } from "./in-flight.ts";
import { recordLatencies } from "./latency.ts";
import { observeResponse, recorderFor, type ResponseObservers } from "./observe.ts";
import {
  brokenCheckCounter,
  EngineMetric,
  ENGINE_COUNTERS,
  keyedCounter,
  OTHER_KEY,
} from "./metric-names.ts";
import type { Clock, Transport, TransportResponse } from "./ports.ts";
import {
  assertRunSpec,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type RunSpec,
  type Scenario,
} from "./run-spec.ts";
import { summariseRun, type RunProgress, type RunSummary } from "./run-summary.ts";
import { mergedSchedule } from "./schedule.ts";

interface ScenarioState<TRequest> extends Scenario<TRequest> {
  readonly metrics: ScenarioMetrics;
  readonly observers: ResponseObservers;
  lastDispatchElapsedMs: number | undefined;
  pendingCount: number;
}

export interface RunPorts<TRequest> {
  readonly clock: Clock;
  readonly transport: Transport<TRequest>;
  /** Defaults to a fresh registry. A worker passes its own, which is the one it snapshots (D1-03). */
  readonly metrics?: MetricsRegistry;
  /**
   * A window onto the run while it is still in flight, for the live view.
   *
   * A handle the caller **reads on its own cadence** rather than a callback the loop pushes into:
   * a callback would fire once per dispatch batch — thousands of times a second — to feed something
   * that redraws a few times a second, and the loop's job is dispatching on schedule, not
   * formatting. Reading costs nothing until someone asks.
   */
  readonly live?: LiveProgress;
}

/**
 * The handle `RunPorts.live` passes in. `runDispatch` fills it in; the caller reads it.
 *
 * `read()` returns `undefined` until the run has actually started, so a reader that arrives early
 * gets nothing rather than a zeroed shape that looks like a run which measured nothing.
 */
export class LiveProgress {
  #read: (() => RunProgress) | undefined;

  /** @internal Called by `runDispatch`. */
  attach(read: () => RunProgress): void {
    this.#read = read;
  }

  read(): RunProgress | undefined {
    return this.#read?.();
  }
}

export interface RunOutcome {
  readonly summary: RunSummary;
  /** The registry everything was recorded into — the worker's side of the merge protocol. */
  readonly metrics: MetricsRegistry;
  /**
   * The facts only this dispatch loop saw, before they were projected into `summary`.
   *
   * A worker sends these to the main thread alongside its metrics snapshot, so the merged run can
   * be projected by `summariseRun` **once, over the merged inputs** — rather than by combining
   * several finished summaries, where a derived field like `achievedRatePerSecond` would have to be
   * re-derived from numbers that had already been rounded into shape.
   */
  readonly progress: RunProgress;
}

/** Declared key spaces as sets, built once per scenario — `has` runs once per keyed increment. */
const keySpacesOf = <TRequest>(scenario: Scenario<TRequest>): Map<string, ReadonlySet<string>> =>
  new Map(
    Object.entries(scenario.keyedCounters ?? {}).map(([name, keys]) => [name, new Set(keys)]),
  );

const observersFor = <TRequest>(
  scenarioMetrics: ScenarioMetrics,
  scenario: Scenario<TRequest>,
): ResponseObservers => ({
  checks: Object.entries(scenario.checks ?? {}),
  onResponse: scenario.onResponse,
  recorder: recorderFor(scenarioMetrics, keySpacesOf(scenario)),
});

/**
 * Claims every name the engine will need before user code can take the slots.
 *
 * The counter map is bounded, and an `onResponse` writing one counter per seat — contract run 2's
 * own shape — reaches that bound legitimately. Whatever the engine has not yet incremented by then
 * is refused, and the report goes quiet about drops, request errors and broken checks precisely in
 * the run that generated the most of them. These names are known before a single request goes out,
 * so there is no reason to be racing user code for them.
 */
const reserveEngineNames = <TRequest>(
  scenarioMetrics: ScenarioMetrics,
  scenario: Scenario<TRequest>,
): void => {
  for (const name of ENGINE_COUNTERS) {
    scenarioMetrics.counters.reserve(name);
  }
  // Per-check, and declared in the config, so these are known too. Without them a check that
  // starts breaking late — an HTML 503 page where JSON was expected — loses its attribution at the
  // exact moment it is earned.
  for (const checkName of Object.keys(scenario.checks ?? {})) {
    scenarioMetrics.counters.reserve(brokenCheckCounter(checkName));
  }
  // Every declared key, plus the implicit `other`. Reserving them is what makes a keyed counter
  // bounded *before* the run rather than capped during it.
  //
  // `other` is reserved **first** within each counter: if the budget ever ran out mid-loop it is
  // the slot that must survive, because it is where every undeclared key lands and losing it drops
  // the very increments the bucket exists to catch. The load-time budget check makes that
  // unreachable through the CLI — but `runDispatch` is exported, so the loader is not the only door.
  for (const [name, keys] of Object.entries(scenario.keyedCounters ?? {})) {
    for (const key of [OTHER_KEY, ...keys]) {
      scenarioMetrics.counters.reserve(keyedCounter(name, key));
    }
  }
};

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
  const states: ScenarioState<TRequest>[] = spec.scenarios.map((scenario) => {
    const scenarioMetrics = metrics.scenario(scenario.name);
    reserveEngineNames(scenarioMetrics, scenario);
    return {
      ...scenario,
      metrics: scenarioMetrics,
      // Flattened and built once per scenario: `Object.entries` and two closures per *response*
      // would allocate for something constant for the whole run.
      observers: observersFor(scenarioMetrics, scenario),
      lastDispatchElapsedMs: undefined,
      pendingCount: 0,
    };
  });

  const inFlight = new InFlight();
  const startedAtMs = clock.now();
  let recordingResponses = true;

  const progressNow = (): RunProgress => ({
    elapsedMs: clock.now() - startedAtMs,
    maxObservedInFlight: inFlight.maxObserved,
    scenarios: states.map((state) => ({
      name: state.name,
      // Carried so `summariseRun` can project flat storage back into the declared shape — it runs
      // on the main thread over merged inputs and never sees the config.
      keyedCounters: state.keyedCounters ?? {},
      scheduledCount: state.profile.count,
      requestedDurationMs: state.profile.durationMs,
      lastDispatchElapsedMs: state.lastDispatchElapsedMs,
    })),
  });
  ports.live?.attach(progressNow);

  /**
   * `ports.ts` requires `send` to *reject* on a transport failure, but a port is inbound data and
   * nothing enforces that contract. A synchronous throw is ordinary in a real transport — `new
   * URL()` on a malformed target, body serialisation, an invalid header value — and thrown from
   * inside the dispatch loop it would escape `runDispatch` entirely: no drain, no summary, nothing
   * published. One bad request must not cost a twenty-minute run, so a sync throw is folded into
   * the same rejection path as an async one, where it is counted as an error like any other.
   *
   * `Promise.resolve` also covers a transport that returns something that is not a promise at all.
   */
  const sendSafely = (request: TRequest): Promise<TransportResponse> => {
    try {
      return Promise.resolve(transport.send(request));
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error), { cause: error }),
      );
    }
  };

  const shard = spec.shard ?? { index: 0, count: 1 };

  const dispatch = (state: ScenarioState<TRequest>, instantMs: number, ordinal: number): void => {
    // The cap is the price of open-loop dispatch: against a target that has stopped answering, the
    // schedule keeps producing instants and memory is otherwise unbounded. Dropped *and* counted.
    if (inFlight.count >= spec.maxInFlight) {
      state.metrics.counters.inc(EngineMetric.dropped);
      return;
    }

    // Global to the run, not local to this shard: four workers each numbering from 0 would make
    // "N buyers, N distinct seats" into four buyers per seat (D2-02). The stride split is exactly
    // this mapping, so it is a recovery rather than an approximation.
    let request: TRequest;
    try {
      request = state.requestFor(shard.index + ordinal * shard.count);
    } catch {
      // A request that could not be built was never sent, so it is not a transport failure and
      // must not be counted as one — the target is not the thing that went wrong.
      state.metrics.counters.inc(EngineMetric.requestErrors);
      return;
    }

    const scheduledAtMs = startedAtMs + instantMs;
    const sentAtMs = clock.now();
    state.lastDispatchElapsedMs = sentAtMs - startedAtMs;
    state.pendingCount += 1;
    state.metrics.counters.inc(EngineMetric.dispatched);
    state.metrics.trend(EngineMetric.scheduleLag).recordMs(Math.max(0, sentAtMs - scheduledAtMs));

    inFlight.track(
      sendSafely(request).then(
        (response): void => {
          state.pendingCount -= 1;
          if (recordingResponses) {
            state.metrics.counters.inc(EngineMetric.responses);
            recordLatencies(state.metrics, { scheduledAtMs, sentAtMs, doneAtMs: clock.now() });
            // After the latency is recorded, deliberately: user code must not be able to inflate
            // the number it is being handed by taking its time about looking at it.
            observeResponse(state.metrics, state.observers, response);
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
      dispatch(next.value.scenario, next.value.instantMs, next.value.index);
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

  const progress = progressNow();

  return { summary: summariseRun(progress, metrics), metrics, progress };
};

import type { ScheduledScenario } from "./schedule.ts";
import { assertDurationMs, assertPositiveCount } from "./validate.ts";

/** How long the run keeps waiting for responses after its last dispatch went out. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/**
 * A scenario: a name, when it dispatches, and what it sends.
 *
 * The request is one value for the whole scenario. Per-request variation (a different seat id per
 * buyer) is the scenario config's job in a later PR, not the transport's — the engine hands
 * whatever it is given straight through.
 */
export interface Scenario<TRequest> extends ScheduledScenario {
  readonly request: TRequest;
}

export interface RunSpec<TRequest> {
  readonly scenarios: readonly Scenario<TRequest>[];
  /**
   * Requests allowed outstanding at once, across the whole run.
   *
   * Mandatory, because open-loop dispatch against a target that has stopped answering is unbounded
   * memory (D1-01): the schedule keeps producing instants whether or not anything comes back.
   * Breaches are dropped **and counted** — a run with drops has an achieved rate below its
   * requested one, and the report has to be able to say so.
   */
  readonly maxInFlight: number;
  /**
   * How long to keep waiting for outstanding responses once the schedule is exhausted. Defaults to
   * {@link DEFAULT_DRAIN_TIMEOUT_MS}. Whatever is still outstanding at the deadline is counted as
   * abandoned and left uncounted in the latency percentiles.
   */
  readonly drainTimeoutMs?: number;
}

/**
 * Validates a run before a single request goes out.
 *
 * Duplicate scenario names are the interesting one: the metrics registry namespaces by name, so
 * two scenarios called `reads` would silently merge into one set of percentiles — a report with a
 * section that is quietly the average of two different things. Cheap to catch here, invisible
 * afterwards.
 */
export const assertRunSpec = <TRequest>(spec: RunSpec<TRequest>): void => {
  if (spec.scenarios.length === 0) {
    throw new RangeError("A run must hold at least one scenario");
  }
  assertPositiveCount(spec.maxInFlight, "maxInFlight");
  if (spec.drainTimeoutMs !== undefined) {
    assertDurationMs(spec.drainTimeoutMs, "drainTimeoutMs");
  }

  const seen = new Set<string>();
  for (const { name } of spec.scenarios) {
    if (seen.has(name)) {
      throw new RangeError(`Scenario names must be unique within a run; "${name}" is repeated`);
    }
    seen.add(name);
  }
};

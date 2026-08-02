import type { ScenarioMetrics } from "../metrics/index.ts";
import { EngineMetric } from "./metric-names.ts";
import type { TransportResponse } from "./ports.ts";

/**
 * Running the user's checks and `onResponse` against one response.
 *
 * This is the file where user-written code executes on the hot path, inside a worker, once per
 * response — so its whole job is to let that code say what it has to say without letting it end the
 * run. D2-04: a check returning `false` is a **failure** and the point of the feature; a check that
 * **throws** is a *broken check*, counted separately and named at the end.
 *
 * The distinction is the same one D1-06 makes for threshold predicates, for the same reason: a bug
 * in an assertion must not be reported as the target violating an invariant, because that sends
 * someone hunting a race condition that was never there. And it must not abort a twenty-minute run
 * either — a load tester that dies mid-run publishes nothing.
 */

export interface ResponseObservers {
  readonly checks: Readonly<Record<string, (response: TransportResponse) => boolean>> | undefined;
  readonly onResponse:
    | ((
        response: TransportResponse,
        record: {
          count: (name: string, by?: number) => void;
          recordMs: (name: string, valueMs: number) => void;
        },
      ) => void)
    | undefined;
}

/**
 * A check that returned something other than a boolean is broken, not failing.
 *
 * Node strips the user's types without checking them, so nothing at runtime guarantees a boolean —
 * and `checks: { ok: (r) => { r.status === 200 } }`, braces instead of parens, returns `undefined`.
 * Counting that as a failure would blame the target for a typo, exactly as it would in a threshold.
 */
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

export const observeResponse = (
  metrics: ScenarioMetrics,
  observers: ResponseObservers,
  response: TransportResponse,
): void => {
  const { checks, onResponse } = observers;

  if (checks !== undefined) {
    for (const [name, predicate] of Object.entries(checks)) {
      try {
        const held: unknown = predicate(response);
        if (isBoolean(held)) {
          metrics.checks.record(name, held);
        } else {
          metrics.counters.inc(EngineMetric.brokenChecks);
          metrics.checks.record(name, false);
        }
      } catch {
        // The error itself is deliberately not kept. It would be a different string per response
        // for a check that throws on every one of them, and the count is what makes the problem
        // visible without a run's worth of noise; the check's *name* is what a reader needs.
        metrics.counters.inc(EngineMetric.brokenChecks);
        metrics.checks.record(name, false);
      }
    }
  }

  if (onResponse !== undefined) {
    try {
      onResponse(response, {
        count: (name, by = 1) => {
          metrics.counters.inc(name, by);
        },
        recordMs: (name, valueMs) => {
          metrics.trend(name).recordMs(valueMs);
        },
      });
    } catch {
      metrics.counters.inc(EngineMetric.brokenObservers);
    }
  }
};

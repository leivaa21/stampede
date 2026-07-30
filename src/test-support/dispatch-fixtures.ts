import { expect } from "vitest";
import type { ArrivalProfile } from "../engine/arrival-profiles.ts";
import { runDispatch, type RunOutcome } from "../engine/dispatcher.ts";
import type { RunSpec, Scenario } from "../engine/run-spec.ts";
import type { ScenarioRunSummary } from "../engine/run-summary.ts";
import type { MetricsRegistry } from "../metrics/index.ts";
import type { FakeClock } from "./fake-clock.ts";
import type { FakeRequest, FakeTransport } from "./fake-transport.ts";

/** Shared setup for the dispatcher's tests — the run itself is the thing under test, not this. */

export const scenario = (name: string, profile: ArrivalProfile): Scenario<FakeRequest> => ({
  name,
  profile,
  request: { label: name },
});

/** Starts a run and drives the fake timeline to its end. Nothing here sleeps for real. */
export const runToCompletion = async (
  spec: RunSpec<FakeRequest>,
  clock: FakeClock,
  transport: FakeTransport,
  metrics?: MetricsRegistry,
): Promise<RunOutcome> => {
  const run = runDispatch(spec, { clock, transport, metrics });
  await clock.runToCompletion();
  return run;
};

export const summaryOf = (outcome: RunOutcome, name: string): ScenarioRunSummary => {
  const found = outcome.summary.scenarios.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`the run reported no scenario named "${name}"`);
  }
  return found;
};

/**
 * A recorded duration is the top of its histogram bucket: at or above the truth, by under 0.1 %.
 * Asserting the bound rather than a rounded number keeps the honest direction of that error inside
 * the test.
 */
export const expectMs = (recordedMs: number | undefined, expectedMs: number): void => {
  expect(recordedMs).toBeGreaterThanOrEqual(expectedMs);
  expect(recordedMs).toBeLessThanOrEqual(expectedMs * 1.001 + 0.001);
};

const US_PER_MS = 1000;

/** The same bound, for the µs-valued latency histograms. */
export const expectLatencyMs = (recordedUs: number | undefined, expectedMs: number): void => {
  expectMs(recordedUs === undefined ? undefined : recordedUs / US_PER_MS, expectedMs);
};

/** The dispatch instants of a 10 rps run over one second, which several tests measure against. */
export const EVERY_TENTH_OF_A_SECOND = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];

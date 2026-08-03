import { constantRate, httpTransport, runDispatch, systemClock } from "../../src/engine/index.ts";
import type { HttpRequestSpec } from "../../src/engine/http-transport.ts";
import type { ScenarioRunSummary } from "../../src/engine/run-summary.ts";
import { setTimeout as sleep } from "node:timers/promises";
import {
  claim,
  ms,
  readTargetStats,
  row,
  section,
  startTarget,
  TARGET_PORT,
  TARGET_URL,
  type TargetStats,
} from "./harness.ts";

/**
 * Can the instrument measure time honestly? Four runs, each one a way of being wrong about it.
 *
 * The transport here is the shipped `httpTransport`, not a copy. It used to be a local one — which
 * meant the gate's headline numbers, the ones quoted in the README and the current-state line, were
 * produced by code that never ships. A regression in the real transport would have left this page
 * green while it kept claiming to have verified the tool against a real target. Evidence has to run
 * the code it is evidence for.
 */

interface GateRun {
  readonly title: string;
  readonly targetArgs: readonly string[];
  readonly ratePerSecond: number;
  readonly durationMs: number;
  /**
   * How many requests this run's title says it makes, written down independently.
   *
   * Deriving it from the profile made the claim `profile.count === profile.count`: the dispatcher
   * reads `scheduledCount` off the same object, so the comparison could not fail under any bug. A
   * planted `constantRate` that produced a tenth of its requests printed "PASS — 4 of 4".
   */
  readonly expectedCount: number;
  readonly check: (summary: ScenarioRunSummary, stats: TargetStats, expectedCount: number) => void;
}

const gateRun = async ({
  title,
  targetArgs,
  ratePerSecond,
  durationMs,
  check,
  expectedCount,
}: GateRun): Promise<void> => {
  section(title);
  const target = await startTarget(targetArgs);
  const profile = constantRate({ ratePerSecond, durationMs });
  try {
    const outcome = await runDispatch<HttpRequestSpec>(
      {
        scenarios: [
          {
            name: "reads",
            profile,
            requestFor: () => ({ url: TARGET_URL }),
          },
        ],
        maxInFlight: 500,
        drainTimeoutMs: 5_000,
      },
      { clock: systemClock, transport: httpTransport },
    );

    const summary = outcome.summary.scenarios[0];
    if (summary === undefined) {
      throw new Error("the run reported no scenario");
    }
    const stats = await readTargetStats();

    row("requested rate", `${String(summary.requestedRatePerSecond)} rps`);
    row(
      "achieved rate — stampede vs target",
      `${(summary.achievedRatePerSecond ?? 0).toFixed(0)} rps vs ${String(stats.achievedRps)} rps`,
    );
    row(
      "dispatched / dropped / errors",
      `${String(summary.dispatchedCount)} / ${String(summary.droppedCount)} / ${String(summary.errorCount)}`,
    );
    row("target received / completed", `${String(stats.received)} / ${String(stats.completed)}`);
    // Printed because run 3 is the one where it is guaranteed non-zero: its published p99 excludes
    // the slowest responses, which understates the truth, and a page that hides that is flattering
    // by omission — the one thing this file exists not to do.
    row(
      "answered / failed / abandoned",
      `${String(summary.responseCount)} / ${String(summary.errorCount)} / ${String(summary.abandonedCount)}`,
    );
    row(
      "latency p50 / p99 (the target)",
      `${ms(summary.latencyMs?.p50Ms)} / ${ms(summary.latencyMs?.p99Ms)}`,
    );
    row(
      "scheduledLatency p50 / p99 (D1-01)",
      `${ms(summary.scheduledLatencyMs?.p50Ms)} / ${ms(summary.scheduledLatencyMs?.p99Ms)}`,
    );
    row("schedule lag max (own backlog)", ms(summary.scheduleLagMs?.maxMs));
    process.stdout.write("\n");

    // Two claims about two different things. The first is arithmetic: does the profile build the
    // number of instants its title advertises. The second has to be an *observed* quantity —
    // `scheduledCount` is a verbatim copy of `profile.count` (`dispatcher.ts`), so pinning it
    // against `expectedCount` restates the first claim rather than checking the loop consumed the
    // schedule. Truncating `constantRate`'s generator while leaving its `count` alone took run 4
    // to a tenth of its load with both of those claims green and `100000 of 100000` printed two
    // rows above `501 sent, 9499 dropped`.
    //
    // What the loop really produces is the disposition of every instant, so that is what is
    // asserted. It subsumes run 3's accounting identity, and it is the shape run 5 already had.
    claim(
      "the profile built the schedule its title claims",
      profile.count === expectedCount,
      `${String(profile.count)} instants for ${String(expectedCount)} requested`,
    );
    claim(
      "every instant the loop consumed is accounted for",
      summary.dispatchedCount + summary.droppedCount + summary.requestErrorCount === expectedCount,
      `${String(expectedCount)} = ${String(summary.dispatchedCount)} sent + ${String(summary.droppedCount)} dropped + ${String(summary.requestErrorCount)} not built`,
    );

    check(summary, stats, expectedCount);
  } finally {
    target.kill();
    await sleep(250);
  }
};

export const timingRuns = async (): Promise<void> => {
  // 1. Can the instrument measure a stopwatch at all? Everything else is moot if not.
  await gateRun({
    title: "RUN 1 — known-latency target: 50ms fixed delay, 20rps for 2s",
    targetArgs: ["--port", String(TARGET_PORT), "--delay", "50"],
    ratePerSecond: 20,
    durationMs: 2_000,
    expectedCount: 40,
    check: (summary, stats) => {
      const p50 = summary.latencyMs?.p50Ms ?? 0;
      claim("p50 lands on the target's real 50ms", p50 >= 48 && p50 <= 65, `${p50.toFixed(1)}ms`);
      claim(
        "every request reached the target",
        stats.received === summary.dispatchedCount,
        `${String(stats.received)} received vs ${String(summary.dispatchedCount)} dispatched`,
      );
      claim(
        "nothing dropped against a healthy target, and every request went out",
        summary.droppedCount === 0 && summary.dispatchedCount === 40,
        `${String(summary.droppedCount)} drops, ${String(summary.dispatchedCount)} of 40 sent`,
      );
      // Nothing in runs 1-4 asserted that what went out came *back*, so a regression that lost
      // responses left the latency percentiles drawn from a subset and every claim green.
      claim(
        "every request that went out came back",
        summary.responseCount === summary.dispatchedCount &&
          summary.errorCount === 0 &&
          summary.abandonedCount === 0,
        `${String(summary.responseCount)} answered, ${String(summary.errorCount)} failed, ${String(summary.abandonedCount)} abandoned`,
      );
    },
  });

  // 2. Does it generate the rate it claims to?
  await gateRun({
    title: "RUN 2 — fast target: 1ms delay, 100rps for 3s",
    targetArgs: ["--port", String(TARGET_PORT), "--delay", "1"],
    ratePerSecond: 100,
    durationMs: 3_000,
    expectedCount: 300,
    check: (summary, stats) => {
      const achieved = summary.achievedRatePerSecond ?? 0;
      claim(
        "achieved rate within 5% of requested",
        Math.abs(achieved - 100) <= 5,
        `${achieved.toFixed(1)} rps`,
      );
      claim(
        "stampede's count agrees with the target's",
        Math.abs(stats.received - summary.dispatchedCount) <= 1,
        `${String(stats.received)} vs ${String(summary.dispatchedCount)}`,
      );
    },
  });

  // 3. The target is slower than the load offered. A closed-loop generator throttles itself here and
  //    publishes the target's *service* time as if it were the user's experience.
  await gateRun({
    title: "RUN 3 — target slower than asked: 200ms delay, capacity 10, asking 200rps for 3s",
    targetArgs: ["--port", String(TARGET_PORT), "--delay", "200", "--capacity", "10"],
    ratePerSecond: 200,
    durationMs: 3_000,
    expectedCount: 600,
    check: (summary, stats) => {
      const p99 = summary.scheduledLatencyMs?.p99Ms ?? 0;
      claim(
        "reports the queue, not the 200ms isolated service time",
        p99 > 1_000,
        `p99 ${p99.toFixed(0)}ms — ${(p99 / 200).toFixed(0)}x the service time`,
      );
      claim(
        "did not throttle itself to the target's ~50rps capacity",
        summary.dispatchedCount >= 550,
        `dispatched ${String(summary.dispatchedCount)} while the target completed ${String(stats.completed)}`,
      );
      // The identity itself is now asserted for every run, against the independently declared
      // size. What is left here is the part specific to this run: its request builder is a
      // constant, so nothing should have failed to build even while the cap is dropping requests.
      claim(
        "every request was built, even while the cap was dropping them",
        summary.requestErrorCount === 0,
        `${String(summary.requestErrorCount)} not built, ${String(summary.droppedCount)} dropped`,
      );
    },
  });

  // 4. The other half of D1-01: when the GENERATOR is the bottleneck, does it admit it, or quietly
  //    report whatever it managed as though that were the rate it was asked for?
  await gateRun({
    title: "RUN 4 — generator overload: asking 50,000rps from one thread for 2s",
    targetArgs: ["--port", String(TARGET_PORT), "--delay", "1"],
    ratePerSecond: 50_000,
    durationMs: 2_000,
    expectedCount: 100_000,
    check: (summary, _stats, expectedCount) => {
      const achieved = summary.achievedRatePerSecond ?? 0;
      const lag = summary.scheduleLagMs?.maxMs ?? 0;
      // Bounded below as well: "far below 50,000" is also true of a run that dispatched five
      // requests, and the point of this run is that the generator kept working while falling behind.
      //
      // Relative to the schedule, and generously, because this is the one number in the gate that
      // is really about the host: my measurements span 1990-2604 dispatched, so a literal near
      // that band would fail a correct tool on a slower box — which the README explicitly says to
      // expect. Half a percent of the schedule still rules out "it dispatched five".
      claim(
        "admits an achieved rate far below the requested one, having really tried",
        achieved < 50_000 && summary.dispatchedCount > expectedCount / 200,
        `${achieved.toFixed(0)} rps of 50,000, ${String(summary.dispatchedCount)} sent, ${String(summary.droppedCount)} dropped`,
      );
      claim("surfaces its own backlog as schedule lag", lag > 50, `${lag.toFixed(0)}ms`);
      claim(
        "the backlog lands in scheduledLatency, above raw latency",
        (summary.scheduledLatencyMs?.p99Ms ?? 0) > (summary.latencyMs?.p99Ms ?? 0),
        `${ms(summary.scheduledLatencyMs?.p99Ms)} vs ${ms(summary.latencyMs?.p99Ms)}`,
      );
    },
  });
};

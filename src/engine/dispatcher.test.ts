import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../metrics/index.ts";
import {
  EVERY_TENTH_OF_A_SECOND,
  expectMs,
  expectRecordedUs,
  runToCompletion,
  scenario,
  summaryOf,
} from "../test-support/dispatch-fixtures.ts";
import { FakeClock } from "../test-support/fake-clock.ts";
import { FakeTransport, type FakeRequest } from "../test-support/fake-transport.ts";
import { burst, constantRate } from "./arrival-profiles.ts";
import { runDispatch } from "./dispatcher.ts";
import { EngineMetric } from "./metric-names.ts";
import type { RunSpec } from "./run-spec.ts";

describe("runDispatch refuses a run it cannot report honestly", () => {
  it("rejects a shard that would send every buyer to the same seat", async () => {
    // `{ index: 0, count: 0 }` makes `shard.index + ordinal * shard.count` zero for every dispatch,
    // so a run asking for 500 distinct seats sends 500 requests for seat 0 and reports success —
    // the exact bug D2-02 exists to detect, reintroduced through the door D2-02 opened. `shard` is
    // a public field on a public type, so a programmatic caller can hand this over.
    await expect(
      runDispatch(
        {
          scenarios: [scenario("reads", burst({ count: 4 }))],
          maxInFlight: 10,
          shard: { index: 0, count: 0 },
        },
        { clock: new FakeClock(), transport: new FakeTransport({ clock: new FakeClock() }) },
      ),
    ).rejects.toThrow(/count/);
  });

  it("accepts the shard a single-threaded run is", async () => {
    const clock = new FakeClock();
    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", burst({ count: 4 }))],
        maxInFlight: 10,
        shard: { index: 0, count: 1 },
      },
      clock,
      new FakeTransport({ clock }),
    );

    expect(summaryOf(outcome, "reads").dispatchedCount).toBe(4);
  });
});

describe("runDispatch keeps the schedule", () => {
  it("dispatches every instant the profile asked for, when it asked for it", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(transport.sentAtMs()).toEqual(EVERY_TENTH_OF_A_SECOND);
    expect(reads.scheduledCount).toBe(10);
    expect(reads.dispatchedCount).toBe(10);
    expect(reads.responseCount).toBe(10);
    expect(reads.droppedCount).toBe(0);
    expect(reads.errorCount).toBe(0);
    expect(reads.abandonedCount).toBe(0);
    expect(reads.requestedRatePerSecond).toBe(10);
    expect(reads.achievedRatePerSecond).toBe(reads.requestedRatePerSecond);
  });

  it("dispatches a whole burst at t = 0", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });

    const outcome = await runToCompletion(
      { scenarios: [scenario("stampede", burst({ count: 250 }))], maxInFlight: 500 },
      clock,
      transport,
    );
    const stampede = summaryOf(outcome, "stampede");

    expect(transport.sentCount).toBe(250);
    expect(transport.sentAtMs().every((atMs) => atMs === 0)).toBe(true);
    expect(stampede.dispatchedCount).toBe(250);
    // A burst asks for a count, not a rate — reporting 250 / 0 ms would be arithmetic, not a fact.
    expect(stampede.requestedRatePerSecond).toBeUndefined();
    expect(stampede.achievedRatePerSecond).toBeUndefined();
  });

  it("times the target, from the send to the response", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 50 });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(reads.latencyMs?.count).toBe(10);
    expectMs(reads.latencyMs?.p50Ms, 50);
    // The generator kept up, so the two numbers agree and the lag is nil — D1-01's healthy case.
    expectMs(reads.scheduledLatencyMs?.p50Ms, 50);
    expect(reads.scheduleLagMs?.maxMs).toBe(0);
  });

  it("keeps dispatching on schedule while the target falls behind — the open-loop property", async () => {
    const clock = new FakeClock();
    // A target 4.5 times slower than the spacing of the requests aimed at it. A closed-loop
    // generator would have sent one request every 450 ms and published a healthy p99 for a system
    // it never actually loaded; this one keeps the schedule and lets the queue build.
    const transport = new FakeTransport({ clock, latencyMs: 450 });

    const outcome = await runToCompletion(
      {
        scenarios: [scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 }))],
        maxInFlight: 100,
      },
      clock,
      transport,
    );
    const reads = summaryOf(outcome, "reads");

    expect(transport.sentAtMs()).toEqual(EVERY_TENTH_OF_A_SECOND);
    expect(reads.scheduleLagMs?.maxMs).toBe(0);
    expect(outcome.summary.maxObservedInFlight).toBe(5);
    expectMs(reads.latencyMs?.p50Ms, 450);
    expect(reads.responseCount).toBe(10);
  });
});

describe("runDispatch across several scenarios", () => {
  it("keeps each scenario's percentiles apart, which is the point of running them together", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({
      clock,
      latencyMs: (request) => (request.label === "reads" ? 10 : 200),
    });

    const outcome = await runToCompletion(
      {
        scenarios: [
          scenario("reads", constantRate({ ratePerSecond: 10, durationMs: 1_000 })),
          scenario("writes", constantRate({ ratePerSecond: 5, durationMs: 1_000 })),
        ],
        maxInFlight: 100,
      },
      clock,
      transport,
    );

    expect(outcome.metrics.scenarioNames).toEqual(["reads", "writes"]);
    expect(transport.sentAtMs("reads")).toEqual(EVERY_TENTH_OF_A_SECOND);
    expect(transport.sentAtMs("writes")).toEqual([0, 200, 400, 600, 800]);

    const reads = summaryOf(outcome, "reads");
    const writes = summaryOf(outcome, "writes");
    expect(reads.responseCount).toBe(10);
    expect(writes.responseCount).toBe(5);
    expectMs(reads.latencyMs?.p99Ms, 10);
    expectMs(writes.latencyMs?.p99Ms, 200);
  });

  it("reports a scenario that scheduled nothing without inventing anything for it", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });

    const outcome = await runToCompletion(
      {
        scenarios: [
          scenario("reads", burst({ count: 2 })),
          scenario("idle", constantRate({ ratePerSecond: 0, durationMs: 1_000 })),
        ],
        maxInFlight: 10,
      },
      clock,
      transport,
    );
    const idle = summaryOf(outcome, "idle");

    expect(idle.scheduledCount).toBe(0);
    expect(idle.dispatchedCount).toBe(0);
    // Not a zero: a p99 of 0 ms for a scenario that never ran is the flattering lie D1-02 rules out.
    expect(idle.latencyMs).toBeUndefined();
    expect(idle.scheduledLatencyMs).toBeUndefined();
  });
});

describe("runDispatch and the metrics registry", () => {
  it("records into the registry it was handed — the one a worker snapshots", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock });
    const registry = new MetricsRegistry();

    const outcome = await runToCompletion(
      { scenarios: [scenario("reads", burst({ count: 4 }))], maxInFlight: 10 },
      clock,
      transport,
      registry,
    );

    expect(outcome.metrics).toBe(registry);
    expect(registry.scenario("reads").counters.get(EngineMetric.dispatched)).toBe(4);
    expect(registry.scenario("reads").counters.get(EngineMetric.responses)).toBe(4);
    expect(registry.scenario("reads").findHistogram(EngineMetric.scheduledLatency)?.count).toBe(4);
  });

  it("survives the snapshot round trip its numbers will have to make", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ clock, latencyMs: 25 });

    const outcome = await runToCompletion(
      { scenarios: [scenario("reads", burst({ count: 4 }))], maxInFlight: 10 },
      clock,
      transport,
    );
    const restored = MetricsRegistry.fromSnapshot(structuredClone(outcome.metrics.toSnapshot(1)));

    expect(restored.toSnapshot(1)).toEqual(outcome.metrics.toSnapshot(1));
    expectRecordedUs(restored.scenario("reads").findHistogram(EngineMetric.latency)?.max, 25);
  });
});

describe("runDispatch rejects a run it cannot honour", () => {
  const ports = {
    clock: new FakeClock(),
    transport: new FakeTransport({ clock: new FakeClock() }),
  };

  it("refuses a run with no scenarios", async () => {
    await expect(runDispatch({ scenarios: [], maxInFlight: 10 }, ports)).rejects.toThrow(
      RangeError,
    );
  });

  it("refuses duplicate scenario names, which would silently share one namespace", async () => {
    const spec: RunSpec<FakeRequest> = {
      scenarios: [scenario("reads", burst({ count: 1 })), scenario("reads", burst({ count: 1 }))],
      maxInFlight: 10,
    };

    await expect(runDispatch(spec, ports)).rejects.toThrow(/unique/);
  });

  it("refuses an in-flight cap that is not a cap", async () => {
    const spec = { scenarios: [scenario("reads", burst({ count: 1 }))], maxInFlight: 0 };

    await expect(runDispatch(spec, ports)).rejects.toThrow(/maxInFlight/);
  });
});

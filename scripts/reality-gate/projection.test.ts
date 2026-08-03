import { describe, expect, it } from "vitest";
import { Projection } from "./projection.ts";

/**
 * The reality gate's arbiter, tested.
 *
 * `pnpm gate:two` cross-checks stampede's recorded projection lag against this model's own number,
 * and the README publishes the result. So a bug here is not a bug in a test fixture — it is a false
 * claim in the showcase. Every method takes `now`, so none of this waits on a real clock.
 */

describe("Projection.behindMs", () => {
  it("is 0 when nothing is waiting — a caught-up projection is not behind", () => {
    expect(new Projection(4).behindMs(1_000)).toBe(0);
  });

  it("is 0 again once the backlog drains", () => {
    const projection = new Projection(4);
    projection.record(0);
    projection.tick();

    expect(projection.behindMs(500)).toBe(0);
  });

  it("measures from the last *applied* event, not from the oldest unapplied one", () => {
    const projection = new Projection(1);
    projection.record(100); // applied by the tick below
    projection.record(200); // still waiting
    projection.record(300); // still waiting
    projection.tick();

    // open-ticket's definition: now (500) minus the last applied event (100) = 400. The oldest
    // *unapplied* event is at 200, which would give 300 — a different number, and a flattering one.
    expect(projection.behindMs(500)).toBe(400);
  });

  it("falls back to the oldest unapplied event before anything has been applied", () => {
    const projection = new Projection(4);
    projection.record(100);

    expect(projection.behindMs(400)).toBe(300);
  });

  it("grows while arrivals outpace the apply rate", () => {
    const projection = new Projection(1);
    for (let i = 0; i < 10; i += 1) {
      projection.record(i * 100);
      projection.tick();
    }

    // Ten arrivals, one applied per tick — no backlog, so it keeps up exactly.
    expect(projection.unappliedCount).toBe(0);

    const behind = new Projection(1);
    const lags: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      behind.record(i * 100);
      lags.push(behind.record(i * 100 + 50)); // two arrivals per tick against a budget of one
      behind.tick();
    }

    expect(behind.unappliedCount).toBe(10);
    // Monotonically, which is what "grows" has to mean: asserting only that the last value is
    // above zero would pass for a lag that spiked once and recovered.
    expect(lags).toEqual([...lags].sort((a, b) => a - b));
    expect(lags.at(-1)).toBeGreaterThan(lags[0] ?? 0);
  });
});

describe("Projection.maxBehindAtRecordMs", () => {
  it("is the peak any recorded event actually observed", () => {
    const projection = new Projection(1);
    projection.record(0);
    projection.tick();
    projection.record(100);
    projection.record(400); // sees 400 - 0 = 400

    expect(projection.maxBehindAtRecordMs).toBe(400);
  });

  it("stops moving once recording stops, however long the clock runs on", () => {
    const projection = new Projection(1);
    projection.record(0);
    projection.record(100);
    projection.record(200);
    const peak = projection.maxBehindAtRecordMs;

    // The backlog is still draining and `behindMs` keeps climbing — but no response carried those
    // values, so they are not part of what stampede should have recorded. A free-running peak made
    // the gate's tolerance a race between the run finishing and the gate reading `/__stats`.
    for (let t = 300; t < 5_000; t += 100) {
      projection.tick();
    }

    expect(projection.maxBehindAtRecordMs).toBe(peak);
    expect(projection.behindMs(50_000)).toBe(0);
  });

  it("never exceeds what a recorded event was told", () => {
    const projection = new Projection(1);
    const observed = [projection.record(0), projection.record(100), projection.record(900)];

    expect(projection.maxBehindAtRecordMs).toBe(Math.max(...observed));
  });
});

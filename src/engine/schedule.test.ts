import { describe, expect, it } from "vitest";
import { burst, constantRate, type ArrivalProfile } from "./arrival-profiles.ts";
import { mergedSchedule, type ScheduledScenario } from "./schedule.ts";

const scenario = (name: string, profile: ArrivalProfile): ScheduledScenario => ({ name, profile });

const dispatchesOf = (scenarios: readonly ScheduledScenario[]): string[] =>
  [...mergedSchedule(scenarios)].map(
    ({ scenario: source, instantMs, index }) =>
      `${source.name}@${String(instantMs)}#${String(index)}`,
  );

describe("mergedSchedule", () => {
  it("walks one scenario's profile in order, numbering its dispatches", () => {
    const dispatches = dispatchesOf([
      scenario("reads", constantRate({ ratePerSecond: 4, durationMs: 1_000 })),
    ]);

    expect(dispatches).toEqual(["reads@0#0", "reads@250#1", "reads@500#2", "reads@750#3"]);
  });

  it("interleaves scenarios by instant, each keeping its own numbering", () => {
    const dispatches = dispatchesOf([
      scenario("reads", constantRate({ ratePerSecond: 4, durationMs: 1_000 })),
      scenario("writes", constantRate({ ratePerSecond: 2, durationMs: 1_000 })),
    ]);

    expect(dispatches).toEqual([
      "reads@0#0",
      "writes@0#0",
      "reads@250#1",
      "reads@500#2",
      "writes@500#1",
      "reads@750#3",
    ]);
  });

  it("breaks ties by the order scenarios are listed in, so a burst run reproduces", () => {
    const first = dispatchesOf([
      scenario("writes", burst({ count: 2 })),
      scenario("reads", burst({ count: 2 })),
    ]);

    expect(first).toEqual(["writes@0#0", "writes@0#1", "reads@0#0", "reads@0#1"]);
  });

  it("carries the scenario itself, not just its name", () => {
    const reads = scenario("reads", burst({ count: 1 }));

    expect([...mergedSchedule([reads])][0]?.scenario).toBe(reads);
  });

  it("stays lazy across scenarios", () => {
    let generated = 0;
    const counting: ArrivalProfile = {
      durationMs: 1_000,
      count: 1_000_000,
      *instants(): Generator<number> {
        for (let index = 0; index < 1_000_000; index += 1) {
          generated += 1;
          yield index;
        }
      },
    };

    const schedule = mergedSchedule([scenario("reads", counting), scenario("writes", counting)]);
    schedule.next();
    schedule.next();

    // One instant of lookahead per scenario, plus one refill after the first dispatch — three
    // instants out of the two million these scenarios have between them.
    expect(generated).toBe(3);
  });

  it("yields nothing for a scenario list with nothing to dispatch", () => {
    expect(dispatchesOf([])).toEqual([]);
    expect(dispatchesOf([scenario("reads", burst({ count: 0 }))])).toEqual([]);
  });
});

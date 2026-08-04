import { describe, expect, it } from "vitest";
import { burst } from "../engine/arrival-profiles.ts";
import { deepFreeze } from "./freeze-state.ts";
import type { StampedeConfig } from "./types.ts";
import {
  DEFAULT_MAX_IN_FLIGHT,
  defaultWorkerCount,
  drainTimeoutMsFor,
  maxInFlightFor,
  scenariosFrom,
  workerCountFor,
} from "./to-run.ts";

const configWith = (
  request: (state: unknown, ordinal: number) => unknown,
): StampedeConfig<unknown> =>
  ({
    scenarios: { reads: { profile: burst({ count: 2 }), request } },
  }) as unknown as StampedeConfig<unknown>;

describe("scenariosFrom", () => {
  it("names each scenario after its key and builds its request from the setup state", () => {
    const scenarios = scenariosFrom(
      configWith((state) => ({ url: `http://x/${String(state)}` })),
      7,
    );

    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]?.name).toBe("reads");
    expect(scenarios[0]?.requestFor(0).url).toBe("http://x/7");
  });

  it("hands the request builder the run's ordinal", () => {
    // D2-02: what makes "N buyers, N distinct seats" expressible at all.
    const scenarios = scenariosFrom(
      configWith((_state, ordinal) => ({ url: `http://x/seat-${String(ordinal)}` })),
      undefined,
    );

    expect(scenarios[0]?.requestFor(0).url).toBe("http://x/seat-0");
    expect(scenarios[0]?.requestFor(41).url).toBe("http://x/seat-41");
  });

  it("validates the built request eagerly, at startup", () => {
    // The common mistake should fail with the scenario named, not as a wall of counted build
    // errors twenty minutes into a run.
    expect(() =>
      scenariosFrom(
        configWith((_state, ordinal) => (ordinal === 0 ? "not a request" : { url: "http://x/" })),
        undefined,
      ),
    ).toThrow(/scenario "reads"/);
  });

  it("refuses a request() that returned the URL instead of a request", () => {
    // The natural first-run slip: the parameter *is* the state and the state often *is* a URL.
    // Unchecked it produces a run where every dispatch fails inside fetch and lands in one
    // undifferentiated error counter — "5 errors" and no way to tell why.
    expect(() =>
      scenariosFrom(
        configWith(() => "http://x/"),
        undefined,
      ),
    ).toThrow(/^scenario "reads": request\(\) must return an object/);
  });

  it("refuses a request() that returned an object with no url", () => {
    expect(() =>
      scenariosFrom(
        configWith(() => ({ path: "/x" })),
        undefined,
      ),
    ).toThrow(/must return a `url` string/);
  });

  it("refuses a data: url, the most convincing false-green available", () => {
    // `fetch("data:…")` answers 200 instantly without a network, so every request "succeeds",
    // every threshold passes, and the report publishes PASSED over a sub-millisecond p50.
    expect(() =>
      scenariosFrom(
        configWith(() => ({ url: "data:text/plain,hello" })),
        undefined,
      ),
    ).toThrow(/non-HTTP url/);
  });

  it("refuses a file: url for the same reason", () => {
    expect(() =>
      scenariosFrom(
        configWith(() => ({ url: "file:///etc/passwd" })),
        undefined,
      ),
    ).toThrow(/non-HTTP url/);
  });

  it("refuses an empty url rather than sending it", () => {
    expect(() =>
      scenariosFrom(
        configWith(() => ({ url: "" })),
        undefined,
      ),
    ).toThrow(/must return a `url` string/);
  });
});

describe("run settings", () => {
  const bare = { scenarios: {} } as unknown as StampedeConfig<unknown>;

  it("falls back to the defaults when the config says nothing", () => {
    expect(maxInFlightFor(bare)).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(workerCountFor(bare)).toBe(defaultWorkerCount());
    expect(drainTimeoutMsFor(bare)).toBeGreaterThan(0);
  });

  it("prefers what the config asked for", () => {
    const config = {
      scenarios: {},
      workers: 3,
      maxInFlight: 17,
      drainTimeoutMs: 250,
    } as unknown as StampedeConfig<unknown>;

    expect(workerCountFor(config)).toBe(3);
    expect(maxInFlightFor(config)).toBe(17);
    expect(drainTimeoutMsFor(config)).toBe(250);
  });

  it("always leaves at least one worker, even on a single-core machine", () => {
    // Floored at 1, not 0: a machine reporting one core should still run the test.
    expect(defaultWorkerCount()).toBeGreaterThanOrEqual(1);
  });

  describe("purity enforcement at the seam", () => {
    it("passes an ordinary builder throw through unchanged", () => {
      // The guard's whole point. Translating every throw would tell someone whose builder hit
      // `Cannot read properties of undefined` that they mutated the setup state — the wrong
      // contract, and a remedy that has nothing to do with their bug.
      expect(() =>
        scenariosFrom(
          {
            scenarios: {
              reads: {
                profile: burst({ count: 1 }),
                // A builder reaching into state that is not there — the commonest real throw, and
                // the one that must not be reported as a purity violation.
                request: (state: { cfg?: { url: string } }) => ({
                  url: (state.cfg as { url: string }).url,
                }),
              },
            },
          } as never,
          {},
        ),
      ).toThrow(/^Cannot read properties of undefined/);
    });

    it("translates a frozen-state violation into the contract it broke", () => {
      expect(() =>
        scenariosFrom(
          {
            scenarios: {
              reads: {
                profile: burst({ count: 1 }),
                request: (state: { seats: string[]; url: string }) => ({
                  url: `${state.url}?seat=${String(state.seats.pop())}`,
                }),
              },
            },
          } as never,
          // Frozen by the caller, exactly as `worker-entry.ts` does — `scenariosFrom` converts, it
          // does not seal its caller's argument.
          deepFreeze({ url: "http://localhost:1/", seats: ["a"] }),
        ),
      ).toThrow(/^scenario "reads": request\(\) mutated the setup state/);
    });
  });
});

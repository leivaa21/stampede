import { describe, expect, it } from "vitest";
import type { ScenarioRunSummary } from "../engine/run-summary.ts";
import { shortfallParts } from "./shortfall.ts";

/**
 * The list three surfaces print. Its value is that they print the *same* list — the CLI, the
 * markdown report and the dashboard each built it inline before this, and the same 9 requests read
 * three different ways depending on where you looked.
 */

const scenario = (over: Partial<ScenarioRunSummary>): ScenarioRunSummary =>
  ({
    droppedCount: 0,
    requestErrorCount: 0,
    impureRequestCount: 0,
    errorCount: 0,
    abandonedCount: 0,
    ...over,
  }) as ScenarioRunSummary;

describe("shortfallParts", () => {
  it("is empty for a clean run", () => {
    // Not "none". A line that prints on every run is a line the reader learns to skip.
    expect(shortfallParts(scenario({}))).toEqual([]);
  });

  it("keeps the two build failures apart, because the remedies have nothing in common", () => {
    const parts = shortfallParts(scenario({ requestErrorCount: 2, impureRequestCount: 9 }));

    expect(parts).toEqual(["2 not built (request() threw)", "9 not built (impure request())"]);
  });

  it("lists what happened in schedule order", () => {
    // Refused before dispatch, never built, sent and failed, sent and never answered — reading
    // left to right follows one request through the run.
    expect(
      shortfallParts(
        scenario({
          droppedCount: 1,
          requestErrorCount: 2,
          impureRequestCount: 3,
          errorCount: 4,
          abandonedCount: 5,
        }),
      ),
    ).toEqual([
      "1 dropped",
      "2 not built (request() threw)",
      "3 not built (impure request())",
      "4 failed",
      "5 abandoned",
    ]);
  });
});

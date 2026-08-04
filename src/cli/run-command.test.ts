import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCountingServer, type CountingServer } from "../test-support/counting-server.ts";
import { ExitCode, runFromConfig } from "./run-command.ts";

/**
 * `stampede run`, end to end: config → setup → storm across threads → teardown → verdict.
 *
 * Against a real server and real worker threads, because the ordering *is* the milestone's argument
 * — an invariant like "exactly one seat sold" can only be asked after the storm, and getting that
 * order wrong is not something a mocked run would notice.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let target: CountingServer;

beforeEach(async () => {
  target = await startCountingServer();
});

afterEach(async () => {
  await target.close();
});

const writeConfig = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "stampede-run-"));
  const file = join(dir, "scenarios.ts");
  writeFileSync(file, `import { defineConfig, burst } from "${REPO_ROOT}src/index.ts";\n${body}`);
  return file;
};

const configFor = (options: {
  url: string;
  teardown?: string;
  thresholds?: string;
  count?: number;
}): string =>
  writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(options.url)} }),
  scenarios: {
    reads: { profile: burst({ count: ${String(options.count ?? 20)} }), request: (s) => ({ url: s.url }) },
  },
  ${options.teardown ?? ""}
  ${options.thresholds ?? ""}
  workers: 2,
  maxInFlight: 40,
  drainTimeoutMs: 3000,
});`);

describe("runFromConfig", () => {
  it("runs the load and passes when every threshold holds", async () => {
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        thresholds: `thresholds: [{ name: "everything answered", assert: (s) => s.scenarios[0].responseCount === 20 }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.verdict?.violated).toEqual([]);
    expect(target.received()).toBe(20);
  }, 30_000);

  it("hands setup state to every worker", async () => {
    // The state never travels as code — only as data — so proving it arrived means proving the
    // requests went where setup said they should.
    const report = await runFromConfig({ configPath: configFor({ url: target.url }) });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(target.received()).toBe(20);
  }, 30_000);

  it("fails with exit 1 when a threshold is violated", async () => {
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        thresholds: `thresholds: [{ name: "p99 under 0ms", assert: (s) => (s.scenarios[0].latencyMs?.p99Ms ?? 1e9) < 0 }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.verdict?.violated).toEqual(["p99 under 0ms"]);
  }, 30_000);

  it("fails with exit 1 when teardown proves the invariant broke", async () => {
    // The headline case: the claim is not about any single response, it is about the state the
    // system was left in. Only teardown can ask it, and only after the storm.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        // `async`, deliberately: a synchronous throw is caught even by a `void`-ed call, so only
        // an async teardown pins that the run actually awaits it.
        teardown: `teardown: async () => { throw new Error("double sell: 2 seats sold"); },`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.failures.join(" ")).toContain("the invariant did not hold");
    expect(report.failures.join(" ")).toContain("double sell");
  }, 30_000);

  it("still evaluates thresholds when teardown failed, so both halves are reported", async () => {
    // Both land on exit 1, so returning early bought nothing and cost the reader the specific
    // half: "the seat sold twice" is the symptom; the named threshold is the claim.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        teardown: `teardown: async () => { throw new Error("double sell"); },`,
        thresholds: `thresholds: [{ name: "impossible", assert: () => false }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.ThresholdViolated);
    expect(report.failures.join(" ")).toContain("double sell");
    expect(report.verdict?.violated).toEqual(["impossible"]);
  }, 30_000);

  it("reports the double sell even when a check is also broken", async () => {
    // Two things went wrong: a predicate has a typo *and* the seat sold twice. Reporting only the
    // typo loses the double sell, which is the thing this tool exists to find. The broken claim
    // decides the exit code — a run whose assertions are unsound cannot be said to have judged the
    // target — but both sentences reach the reader.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)} }),
  scenarios: {
    reads: {
      profile: burst({ count: 20 }),
      request: (s) => ({ url: s.url }),
      checks: { parsesBody: (r) => JSON.parse("not json").ok },
    },
  },
  teardown: async () => { throw new Error("double sell: 2 sold"); },
});
`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("broken observations");
    expect(report.failures.join(" ")).toContain("double sell: 2 sold");
  }, 30_000);

  it("reports every reason a run failed, not only the first", async () => {
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)} }),
  scenarios: {
    reads: {
      profile: burst({ count: 20 }),
      request: (s) => ({ url: s.url }),
      checks: { parsesBody: (r) => JSON.parse("not json").ok },
    },
  },
  thresholds: [{ name: "throws", assert: () => { throw new Error("bad claim"); } }],
});
`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("a threshold predicate threw");
    expect(report.failures.join(" ")).toContain("broken observations");
  }, 30_000);

  it("fails with exit 2 when a config asked for more metric names than the caps allow", async () => {
    // A counter per seat is a cardinality bomb, and it reaches the cap legitimately. The refused
    // names are missing *entirely*, so a threshold reading one gets a confident 0 and reports a
    // violation the target never caused — this has to fail the run rather than pass quietly.
    const configPath = writeConfig(`let seen = 0;
export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)} }),
  scenarios: {
    reads: {
      profile: burst({ count: 600 }),
      request: (s) => ({ url: s.url }),
      // Per *worker*, unlike \`request\`: this counter is only ever read by the worker that owns it,
      // and the run is single-threaded so the names are 1..600.
      onResponse: (r, record) => { seen += 1; record.count("seat-" + String(seen)); },
    },
  },
  workers: 1,
  maxInFlight: 1000,
  drainTimeoutMs: 3000,
});
`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("refused");
    expect(report.failures.join(" ")).toContain("cardinality bomb");
    expect(report.summary?.scenarios[0]?.refusedRecordings).toBeGreaterThan(0);
  }, 30_000);

  it("names the purity contract when request() mutates the setup state", async () => {
    // The whole point of the message: without it a user sees "Cannot delete property '1' of
    // [object Array]" from inside `Array.prototype.pop`, naming neither the scenario, nor
    // `request()`, nor the rule it broke.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)}, seats: ["a", "b", "c"] }),
  scenarios: {
    reads: {
      profile: burst({ count: 3 }),
      request: (s) => ({ url: s.url + "?seat=" + String(s.seats.pop()) }),
    },
  },
  workers: 1,
  maxInFlight: 16,
  drainTimeoutMs: 3000,
});`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    const failure = report.failures.join(" ");
    expect(failure).toContain('scenario "reads": request() mutated the setup state');
    expect(failure).toContain("pure function of (state, ordinal)");
    // And it says what to do instead, because "your builder is impure" is a diagnosis without a
    // remedy for someone who reached for `pop()` precisely to get a different seat each time.
    expect(failure).toContain("seats[ordinal % seats.length]");
  }, 30_000);

  it("reports a builder that goes impure *after* ordinal 0, which startup cannot catch", async () => {
    // The startup path and the dispatch path are two different guards, and only this shape reaches
    // the second. The other purity test pops at every ordinal, so it fails the eager `build(0)`
    // while the worker is still starting — leaving the whole dispatch-time half of the contract
    // (its own counter, its own finder, its own exit code) asserted by nothing.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)}, seats: ["a", "b", "c", "d"] }),
  scenarios: {
    reads: {
      profile: burst({ count: 4 }),
      request: (s, ordinal) =>
        ordinal === 0 ? { url: s.url } : { url: s.url + "?seat=" + String(s.seats.pop()) },
    },
  },
  workers: 1,
  maxInFlight: 16,
  drainTimeoutMs: 3000,
});`);

    const report = await runFromConfig({ configPath });

    // Exit 2, not 1: three of the four requests were never made, so the numbers describe a run
    // that did not happen rather than a target that misbehaved.
    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.summary?.scenarios[0]?.impureRequestCount).toBe(3);
    // Counted as its *own* term, not folded into build errors — the two have different remedies.
    expect(report.summary?.scenarios[0]?.requestErrorCount).toBe(0);
    expect(report.summary?.scenarios[0]?.responseCount).toBe(1);
    const failure = report.failures.join(" ");
    expect(failure).toContain("could not build 3 requests");
    expect(failure).toContain("seats[ordinal % seats.length]");
  }, 30_000);

  it("catches an impure builder in a config Node loads as CommonJS, where freezing would not", async () => {
    // The claim the whole guard design rests on. A `.ts` file in a package with
    // `"type": "commonjs"`, written with `module.exports`, genuinely loads as CommonJS and runs in
    // **sloppy mode** — where `Object.freeze` stops throwing and silently discards the write
    // instead. The first version of this guard was a deep freeze, so in this exact file D25-02
    // enforced nothing at all, and the user's own mutation was dropped too: a builder meant to
    // vary its output sent the same value every time with nothing anywhere to say why.
    //
    // Written without `import`/`export`, because those are what make Node reparse it as ESM.
    const dir = mkdtempSync(join(tmpdir(), "stampede-sloppy-"));
    writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
    const file = join(dir, "scenarios.ts");
    writeFileSync(
      file,
      `const { defineConfig, burst } = require("${REPO_ROOT}src/index.ts");\n` +
        `module.exports = defineConfig({\n` +
        `  setup: () => ({ url: ${JSON.stringify(target.url)}, seats: ["a", "b", "c", "d"] }),\n` +
        `  scenarios: { reads: { profile: burst({ count: 4 }),\n` +
        `    request: (s, ordinal) => ordinal === 0 ? { url: s.url } : { url: s.url + "?s=" + String(s.seats.pop()) } } },\n` +
        `  workers: 1, maxInFlight: 16, drainTimeoutMs: 3000,\n});\n`,
    );

    const report = await runFromConfig({ configPath: file });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.summary?.scenarios[0]?.impureRequestCount).toBe(3);
    expect(report.failures.join(" ")).toContain("mutated the setup state");
  }, 30_000);

  it("explains the guard when a pure builder copies the state with structuredClone", async () => {
    // Copy-then-edit is the idiomatic way to *obey* the purity contract, and `structuredClone`
    // cannot copy a proxy — so the guard breaks the very pattern it asks for. This builder never
    // touches the state. Untranslated it reached the user as `worker-0: #<Object> could not be
    // cloned.`, naming neither the scenario, nor `request()`, nor the guard, nor a way out.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)}, template: { kind: "buy", seat: null } }),
  scenarios: {
    reads: {
      profile: burst({ count: 2 }),
      request: (s, ordinal) => {
        const body = structuredClone(s.template);
        body.seat = "seat-" + String(ordinal);
        return { url: s.url, method: "POST", body: JSON.stringify(body) };
      },
    },
  },
  workers: 1,
  maxInFlight: 8,
  drainTimeoutMs: 3000,
});`);

    const report = await runFromConfig({ configPath });

    const failure = report.failures.join(" ");
    expect(failure).toContain('scenario "reads": request() could not clone a value');
    expect(failure).toContain("proxies cannot be structured-cloned");
    expect(failure).toContain("JSON.parse(JSON.stringify(state.thing))");
    // The remedy is qualified rather than blanket: a JSON round-trip turns a Date into a string
    // and a Buffer into `{type,data}`, and this repo names a Buffer in setup state as the
    // canonical shape for an authed API. Prescribing it unconditionally would corrupt values on
    // the wire, silently, on the tool's own advice.
    expect(failure).toContain("if it is JSON-shaped");
    expect(failure).toContain("[...state.list]");
    // `build(0)` kills the worker before a summary exists, so there are no counts to assert here —
    // `impureRequestCount ?? 0` would be `undefined ?? 0` and could never fail. The classification
    // is asserted in the later-ordinal test above, which is the only path that can observe it.
    expect(report.summary).toBeUndefined();
    expect(report.exitCode).toBe(ExitCode.RunFailed);
  }, 30_000);

  it("fails a run whose builder lost most of the schedule after ordinal 0", async () => {
    // The half `build(0)` cannot catch. The clone succeeds at ordinal 0 by luck of the config's
    // shape, so the worker starts, and every later build throws — nine of ten requests gone
    // because of stampede's own guard, against a builder that obeyed the contract.
    //
    // Before `findLostSchedule` this printed `shortfall 9 not built (request() threw)`, published a
    // p99 from the single sample, and exited **0** with a green threshold. That is the failure
    // D25-02's own record calls disqualifying — "refusing 90 % of its own load and reporting
    // success" — reached by a different cause.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)}, template: { kind: "buy" } }),
  scenarios: {
    reads: {
      profile: burst({ count: 10 }),
      request: (s, ordinal) => {
        if (ordinal === 0) return { url: s.url };
        const body = structuredClone(s.template);
        return { url: s.url, method: "POST", body: JSON.stringify(body) };
      },
    },
  },
  workers: 1,
  maxInFlight: 16,
  drainTimeoutMs: 3000,
});`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("never built 9 of its 10 requests");
    // The classification, asserted where it can actually be observed: at `build(0)` the run dies
    // before a summary exists, so `impureRequestCount` there is `undefined` and any assertion on
    // it passes for the wrong reason. Here the summary is real. A clone failure is an ordinary
    // build failure — the builder did nothing wrong, and calling it impure accuses it of the
    // opposite of what it did.
    expect(report.summary?.scenarios[0]?.requestErrorCount).toBe(9);
    expect(report.summary?.scenarios[0]?.impureRequestCount).toBe(0);
  }, 30_000);

  it("lets the documented copy-then-edit workaround through", async () => {
    // The remedy the message prescribes has to actually work, or it is a worse failure than none.
    const configPath = writeConfig(`export default defineConfig({
  setup: () => ({ url: ${JSON.stringify(target.url)}, template: { kind: "buy", seat: null } }),
  scenarios: {
    reads: {
      profile: burst({ count: 2 }),
      request: (s, ordinal) => {
        const body = JSON.parse(JSON.stringify(s.template));
        body.seat = "seat-" + String(ordinal);
        return { url: s.url, method: "POST", body: JSON.stringify(body) };
      },
    },
  },
  workers: 1,
  maxInFlight: 8,
  drainTimeoutMs: 3000,
});`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.summary?.scenarios[0]?.responseCount).toBe(2);
  }, 30_000);

  it("runs teardown after the storm, not before it", async () => {
    // The ordering *is* the milestone's argument, so it is asserted from inside the config: teardown
    // asks the target how many requests it has seen, and throws if the storm has not happened yet.
    // Run in the wrong order this fails with exit 1 rather than passing quietly.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        teardown: `teardown: async () => {
          const seen = await (await fetch(${JSON.stringify(`${target.url}__count`)})).json();
          if (seen.received < 20) {
            throw new Error("teardown ran before the storm: only " + seen.received + " requests had landed");
          }
        },`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.failures).toEqual([]);
  }, 30_000);

  it("fails with exit 2 when nothing could be measured", async () => {
    const report = await runFromConfig({
      configPath: configFor({ url: "http://127.0.0.1:1/" }),
    });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("recorded no responses");
  }, 30_000);

  it("fails with exit 2 when setup itself throws", async () => {
    const configPath = writeConfig(`export default defineConfig({
  setup: () => { throw new Error("could not seed the show"); },
  scenarios: { reads: { profile: burst({ count: 1 }), request: () => ({ url: "http://127.0.0.1:1/" }) } },
});`);

    const report = await runFromConfig({ configPath });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("setup() failed");
    expect(report.failures.join(" ")).toContain("could not seed the show");
  }, 30_000);

  it("fails with exit 2 when a threshold predicate throws", async () => {
    // A broken claim is the config's mistake, not the target's — blaming the system for it would
    // send someone hunting a race condition that was never there.
    const report = await runFromConfig({
      configPath: configFor({
        url: target.url,
        thresholds: `thresholds: [{ name: "reaches into nothing", assert: (s) => s.nope.deeper === 1 }],`,
      }),
    });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.verdict?.broken).toEqual(["reaches into nothing"]);
  }, 30_000);

  it("fails with exit 2 when the config does not exist", async () => {
    const report = await runFromConfig({ configPath: "/nowhere/scenarios.ts" });

    expect(report.exitCode).toBe(ExitCode.RunFailed);
    expect(report.failures.join(" ")).toContain("No config file at");
  }, 30_000);

  it("lets --workers override what the config asked for", async () => {
    const report = await runFromConfig({
      configPath: configFor({ url: target.url, count: 12 }),
      workers: 1,
    });

    expect(report.exitCode).toBe(ExitCode.Ok);
    expect(report.summary?.scenarios[0]?.scheduledCount).toBe(12);
  }, 30_000);
});

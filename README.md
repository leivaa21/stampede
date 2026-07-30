# stampede

A load-testing CLI that proves **invariants**, not just percentiles. Point it at an HTTP API,
describe scenarios in typed TypeScript, and get a live terminal dashboard plus a paste-ready
markdown report — with named checks, custom counters merged across worker threads, and thresholds
that decide the exit code.

> **Status: M1 in progress.** The design is settled (`docs/design/m1.md`) and the repo is scaffolded;
> the engine is being built. The API below is the designed shape — this README will show real
> numbers, not intentions, before it ships. See [Status](#status).

## Why it exists

Most load tools answer _"how fast is it?"_. The question that actually blocks a launch is _"is it
still correct when 500 people hit the same row at once?"_ — and that is a claim about a **run**, not
a request. stampede makes those claims first-class:

```ts
// scenarios.ts
import { defineConfig, burst } from "@leivaa21/stampede";

export default defineConfig({
  // Runs once, on the main thread. Its return value is handed to every virtual user,
  // so it must be plain data.
  setup: async () => {
    const res = await fetch("http://localhost:5210/shows", { method: "POST" /* … */ });
    const { showId, seatId } = await res.json();
    return { showId, seatId };
  },

  scenarios: {
    theStampede: {
      profile: burst({ count: 500 }), // 500 buyers, same seat, all at once
      request: ({ showId, seatId }) => ({
        method: "POST",
        url: `http://localhost:5210/shows/${showId}/reservations`,
        body: { seatIds: [seatId] },
      }),
      checks: {
        oneWinnerOrConflict: (res) => res.status === 201 || res.status === 409,
      },
      onResponse: (res, { counters }) => {
        if (res.status === 201) counters.inc("reserved201");
      },
    },
  },

  // Runs after the storm — the invariant is proven, not just observed.
  teardown: async ({ showId, seatId }) => {
    const seat = await getSeat(showId, seatId);
    if (seat.soldCount !== 1) throw new Error(`double sell: ${String(seat.soldCount)}`);
  },

  thresholds: [
    { name: "exactly one buyer wins", assert: (s) => s.counters.reserved201 === 1 },
    { name: "no failed checks", assert: (s) => s.checks.oneWinnerOrConflict.failed === 0 },
    { name: "p99 under 250ms", assert: (s) => s.scenarios.theStampede.p99 < 250 },
  ],
});
```

```bash
stampede run scenarios.ts                      # live TUI
stampede run scenarios.ts --report out.md --ci # headless, thresholds → exit code
```

A violated invariant **fails CI** (exit `1`) instead of printing a red number.

## Quickstart

```bash
pnpm install
pnpm dev -- run scenarios.ts   # no build step — Node 24 strips the types
```

Scenario configs are plain TypeScript loaded directly by Node, so they must use **erasable syntax
only**: no `enum`, no parameter properties, no `namespace`. stampede translates the resulting Node
error into a message that names the file and the construct.

## Architecture

```
src/
├── cli.ts        # arg parsing, exit codes — the only process.exit in the repo
├── index.ts      # programmatic entry: run an engine, get a summary back
├── config/       # TS config loading, defineConfig types, edge validation
├── metrics/      # histogram · counters · checks · merge   (pure, no I/O)
├── engine/       # arrival profiles · scheduler · worker pool · HTTP dispatch
├── report/       # markdown renderer
└── tui/          # live dashboard (the only consumer allowed to draw)
```

The engine imports no UI code and is exported for programmatic use; the TUI and the reporter are two
independent consumers of its typed event stream.

## Decisions

The four that shaped everything else — full rationale in [`docs/decisions.md`](docs/decisions.md):

- **Open-loop arrivals, latency timed from the _scheduled_ instant.** Closed-loop generators hide
  **coordinated omission**: a slow target throttles the generator, so latency samples come
  disproportionately from healthy moments and p99 flatters the system exactly when it shouldn't.
  Timing from the scheduled instant puts generator backlog _into_ the number instead of hiding it.
- **HDR-style bucketed histograms.** Merging across workers has to be lossless and
  order-independent — elementwise addition. t-digest merges are approximate _and_ order-dependent,
  so published numbers would depend on which worker finished first.
- **Node 24 native type-stripping** for scenario configs. No bundler, no build step, no dependency,
  and identical behaviour in the main thread and in workers — which the architecture depends on.
- **Thresholds are named typed predicates**, not a string mini-language. The TS config is the DSL;
  the threshold's name is what the CI failure prints.

Honesty is a design rule, not a feature: dropped requests, histogram overflow, and achieved-vs-
requested rate are always reported. If the tool can't keep up, the report says so.

## Status

- **Designed:** M1 — open-loop engine, mergeable metrics, TS config, setup/teardown, thresholds,
  live TUI, markdown report. See [`docs/design/m1.md`](docs/design/m1.md).
- **Next:** the `metrics/` core, then the scheduler.
- **Deferred on purpose:** SSE / long-lived streaming requests, distributed workers, protocols
  beyond HTTP(S), a cloud service, a scripting DSL.

Built as the instrument for [open-ticket](https://github.com/leivaa21/open-ticket)'s published load
numbers — built the instrument, then used it to validate the architecture.

---

MIT © Adrián Leiva ([leivaa21](https://github.com/leivaa21)) · part of
[whos.leivaa.dev](https://whos.leivaa.dev)

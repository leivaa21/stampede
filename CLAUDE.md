# CLAUDE.md — stampede

> **What this repo is:** a load-testing CLI that proves **invariants**, not just percentiles — point
> it at an HTTP API, describe scenarios in typed TypeScript, and get a live terminal dashboard plus a
> paste-ready markdown report. Named checks, custom counters merged across worker threads, and
> thresholds that set the exit code are what make it an assertion tool rather than a benchmarker.
> Part of leivaa's public-projects workspace — the workspace `../CLAUDE.md` rules (quality,
> security, docs, git) apply here in full; this file only adds what's specific to this project.
> Read this file before every task and re-read the **Current state** line.

> **Current state (2026-07-30):** **M1 PRs 1–3 merged — the engine measures honestly, single
> threaded.** `metrics/`: HDR-style histograms (17,408 `Int32` counts = 68 KiB, worst-case error
> 0.0975 %) whose merge is exact, associative and commutative, plus counters, checks, trends, and a
> snapshot protocol with sequence numbers so a delayed message cannot rewind an aggregate.
> `engine/`: pure lazy arrival profiles (`constantRate` · `ramp` · `burst` · `stages`) and an
> open-loop dispatcher behind clock and transport ports. 217 tests, audit clean.
> **Gate two passes against a real HTTP target** (`pnpm gate:two`): a 50 ms target reads 52 ms; a
> target slower than the load offered reports p99 5931 ms against its 200 ms service time without
> throttling itself; and asked for 50,000 rps on one thread it admits ~1,900 achieved, counts 95k
> drops, and puts its own 320 ms backlog into `scheduledLatency` rather than hiding it.
> **Worker pool (PR 4) is in too:** the schedule is split across threads by **stride** (shard `w` of
> `W` takes indices `w, w+W, …`), so the shards _are_ the run by construction rather than by
> arithmetic that has to add up — every profile shape inherits it, including `stages`. Workers own
> private registries and post cumulative sequence-numbered snapshots; the main thread merges and
> projects once. Proven against the live target: 4 threads, 480 scheduled, 480 dispatched, **480
> received by the target**, accounting balanced, zero out-of-order snapshots.
> **Config loading (PR 5) is in:** `defineConfig` anchors `TSetup`, so `setup()` → `request(state)`
> → `teardown(state)` are typed end to end with no annotations in the user's file. Node strips the
> types — no bundler, no build step — and the loader translates
> `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` into the file plus the fix. Ships the real HTTP transport,
> which follows **no** redirects on purpose. 284 tests.
> **`stampede run` works (PR 6).** setup → storm across threads → teardown → verdict, in that
> order, because an invariant like "exactly one seat sold" can only be asked after the storm. Exit
> codes are a contract: **0** every threshold held · **1** a threshold was violated _or_ teardown
> proved the invariant broke · **2** the run itself failed. A scenario that recorded no responses
> fails the run before any threshold is evaluated, so `(s.p99 ?? 0) < 250` can never let a scenario
> that never ran pass. 316 tests.
> **Verified against a target that double-sells:** `teardown() failed — the invariant did not hold
after the run: double sell: 300 seats sold`, exit 1. That is open-ticket's M5 case working.
> **Not built yet:** the markdown report (PR 7) and the live TUI (PR 8). `--report` and `--ci` do
> not exist as flags yet — an unknown flag is an error, not a shrug.
> Next: PR 7 — the markdown report. Keep this line current after every merged slice.

## Identity

- **Registry index:** 1 (see `../PROJECTS.md`)
- **Ports:** none (CLI)
- **Repo:** github.com/leivaa21/stampede · **npm:** `@leivaa21/stampede` · **License:** MIT

## What it does & how it's shaped

Single-package TypeScript CLI, flat by responsibility. The **engine** (arrival scheduling, worker
threads, HTTP dispatch, metrics) has no UI imports and is exported for programmatic use; the **TUI**
and the **markdown reporter** are two independent consumers of the engine's typed event stream.

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

## Project-specific conventions

- **The engine never imports the TUI.** Enforced by an ESLint import-boundary rule, not by habit.
- **`metrics/` stays pure** — no I/O, no timers, no `Date.now()` inside the data structures. It is
  the most-tested code in the repo because every published number comes out of it.
- **Merges must be associative and commutative.** Anything merged across workers (histogram buckets,
  counters, check tallies) is tested for both — worker completion order must never change a
  published number.
- **Honesty over flattering numbers.** Dropped requests, histogram overflow, and achieved-vs-requested
  rate are always reported. If the tool cannot keep up, the report says so. Never silently throttle.
- **Latency is measured from the _scheduled_ dispatch instant**, not the actual send — see D1-01.
  Anyone "fixing" this to measure from send is reintroducing coordinated omission.
- **Scenario configs are erasable-syntax TS only** (no `enum`, no parameter properties, no
  `namespace`) — a Node type-stripping constraint. Config-loading errors get translated into
  actionable messages, never raw stack traces.
- **`setup()` returns structured-cloneable data.** Functions cannot cross the worker boundary; every
  worker imports the config file itself.

## Commands

```bash
pnpm install
pnpm dev        # node src/cli.ts — no build step, Node strips the types
pnpm test
pnpm lint && pnpm typecheck && pnpm build
pnpm audit      # must stay clean (overrides in pnpm-workspace.yaml)
```

## Non-goals

Not k6/Gatling. No distributed workers, no protocol zoo (HTTP(S) only at first), no cloud service,
**no scripting DSL — the TS config is the DSL**. SSE / long-lived streaming requests are a named
later milestone, not a gap to paper over. Say no on purpose.

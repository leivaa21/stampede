# CLAUDE.md — stampede

> **What this repo is:** a load-testing CLI that proves **invariants**, not just percentiles — point
> it at an HTTP API, describe scenarios in typed TypeScript, and get a live terminal dashboard plus a
> paste-ready markdown report. Named checks, custom counters merged across worker threads, and
> thresholds that set the exit code are what make it an assertion tool rather than a benchmarker.
> Part of leivaa's public-projects workspace — the workspace `../CLAUDE.md` rules (quality,
> security, docs, git) apply here in full; this file only adds what's specific to this project.
> Read this file before every task and re-read the **Current state** line.

> **Current state (2026-08-01):** **M1 is complete — `stampede run` works end to end.** 401 tests,
> audit clean, every slice through the implementer → reviewer loop.
>
> `metrics/`: HDR-style histograms (17,408 `Int32` counts = 68 KiB, worst-case error 0.0975 %) whose
> merge is exact, associative and commutative, plus counters, checks, trends, and a
> sequence-numbered snapshot protocol. `engine/`: pure lazy arrival profiles, an open-loop
> dispatcher behind clock and transport ports, a worker pool that splits the schedule **by stride**
> so the shards are the run by construction, and the real HTTP transport (no redirects, on purpose).
> `config/`: `defineConfig` anchoring `TSetup` so setup → request → teardown type end to end, loaded
> by Node's own type-stripping. `cli/`: setup → storm → teardown → verdict, with exit codes CI can
> act on. `report/`: a paste-ready markdown table carrying its own provenance. `tui/`: a live
> dashboard that redraws in place and is silent when piped.
>
> **Gate two (`pnpm gate:two`) is the proof, and it runs the shipped code.** A 50 ms target reads
> 52 ms; a target slower than the load offered reports p99 5910 ms against its 200 ms service time
> without throttling itself; asked for 50,000 rps on one thread it admits 6,181 achieved, counts
> 87,302 drops, and puts its own 130 ms backlog into `scheduledLatency`; and a 4-thread pooled run
> is cross-checked by the target's own request count.
>
> **Not done:** not published to npm (`@leivaa21/stampede` is reserved, `publishConfig` is set).
> **M2 is designed and in progress** (`docs/design/m2.md`): the assertion machinery reaches the
> response. `TransportResponse` gains headers and text (the bytes are already read for timing);
> per-scenario `checks` and `onResponse` feed the `Counters`/`Checks` that `metrics/` has had since
> M1 and nothing could reach; `request(state, index)` carries the **run's** ordinal, not the shard's;
> counters and checks land per scenario on the threshold-facing summary. That makes open-ticket's
> contract runs 1, 2 and 4 expressible — SSE fan-out (run 5) is M3, and open-ticket said in writing
> it is not waiting on it. Keep this line current after every merged slice.

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
├── cli.ts        # the binary: argv in, exit code out
├── cli/          # arg parsing · run orchestration · thresholds · terminal output
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

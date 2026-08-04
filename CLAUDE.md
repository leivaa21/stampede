# CLAUDE.md — stampede

> **What this repo is:** a load-testing CLI that proves **invariants**, not just percentiles — point
> it at an HTTP API, describe scenarios in typed TypeScript, and get a live terminal dashboard plus a
> paste-ready markdown report. Named checks, custom counters merged across worker threads, and
> thresholds that set the exit code are what make it an assertion tool rather than a benchmarker.
> Part of leivaa's public-projects workspace — the workspace `../CLAUDE.md` rules (quality,
> security, docs, git) apply here in full; this file only adds what's specific to this project.
> Read this file before every task and re-read the **Current state** line.

> **Current state (2026-08-05):** **M2 is complete — stampede proves invariants, not just
> percentiles.** 550+ tests, audit clean, every slice through the implementer → reviewer loop.
>
> M1 built the instrument: HDR-style histograms whose merge is exact and order-independent, an
> open-loop dispatcher behind clock and transport ports, a worker pool that splits the schedule by
> stride, TS configs loaded by Node's own type-stripping, and a CLI whose exit codes CI can act on.
>
> **M2 made it an assertion tool.** `TransportResponse` carries status, headers and text — the bytes
> were already read for timing. Per-scenario `checks` are named predicates counted **three ways**:
> passed, failed, and _broken_, because a check that throws is a bug in the claim and reporting it
> as a failure accuses the target of an invariant violation that was a typo (D2-04). `onResponse`
> feeds counters and trends merged across every worker thread. `request(state, ordinal)` carries the
> **run's** ordinal rather than the shard's, so "N buyers, N distinct seats" survives four threads.
> Counters, checks and trends land per scenario on the threshold-facing summary, in the markdown
> report, and live on the dashboard while a check is still failing.
>
> The engine's own counters are **reserved by registration**, not merely by prefix: a user counter
> per seat fills the 512-name budget, and before this every engine counter that had not yet fired
> was refused — a run that dropped 350 requests reporting zero drops. Refused recordings are now a
> published number that fails the run, because a threshold reading a refused counter reads a
> confident 0.
>
> **Gate two (`pnpm gate:two`) is the proof, and it runs the shipped code.** A manual milestone
> gate rather than a CI job — it spawns servers and leans on real timing. Numbers below are from a
> 16-core dev box; the _relationships_ are what the claims assert, not the absolute throughput.
> Seven runs, 39 claims: a 50 ms
> target reads 52 ms; a target slower than the load offered reports p99 5910 ms against its 200 ms
> service time without throttling itself; asked for 50,000 rps on one thread it admits about a
> thousand achieved and puts its own ~490 ms backlog into `scheduledLatency` (this one is the least
> reproducible number in the gate — read the relationship, not the digits); a 4-thread pooled run is
> cross-checked by the target's own request count; and open-ticket's contract runs 1, 2 and 4 are
> produced against a reference target that **sells seats and counts them itself** — 200 buyers on
> one seat yield exactly one 201 and the target agrees it sold one; 200 buyers on 200 distinct
> seats across 4 threads yield 200 sales with zero collisions, which is the ordinal mapping proved
> by something other than stampede; and every one of the 200 projection-lag samples the config
> recorded through `onResponse` survives the merge, with the peak agreeing to within the histogram's
> rounding. The sample count is the load-bearing claim there — losing a whole worker's trend moves
> the peak by under a millisecond, so a peak-only check would have passed at 150 of 200 samples.
>
> **Not done:** not published to npm (`@leivaa21/stampede` is reserved, `publishConfig` is set) —
> leivaa's call, not a task to pick up. **M3 is SSE / long-lived streaming**, open-ticket's contract
> run 5, which it said in writing it is not waiting on. Both debts M2 surfaced are paid: M2.5
> landed declared key spaces (D25-01) and `request()` purity enforced by guarding the setup state
> in each worker (D25-02). Keep this line current after every merged slice.

## Identity

- **Registry index:** 1 (see `../PROJECTS.md`)
- **Ports:** none in production — it is a CLI. `pnpm gate:two` binds **127.0.0.1:5999** for its
  reference target: loopback only, test-only, and deliberately outside the workspace's `5 P S V`
  range so it can never be mistaken for, or collide with, a real service.
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

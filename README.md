# stampede

A load-testing CLI that proves **invariants**, not just percentiles. Point it at an HTTP API,
describe scenarios in typed TypeScript, and get a live terminal dashboard plus a paste-ready
markdown report — with named checks, custom counters merged across worker threads, and thresholds
that decide the exit code.

> **M1 is done, and M2 lands the assertion machinery.** Named checks, custom counters merged across
> worker threads, and per-_request_ variation all work today. The numbers below are from real runs,
> not intentions — see [Proving the numbers](#proving-the-numbers).

## Why it exists

Most load tools answer _"how fast is it?"_. The question that actually blocks a launch is _"is it
still correct when 500 people hit the same row at once?"_ — and that is a claim about a **run**, not
a request. stampede makes those claims first-class:

```ts
// scenarios.ts — this runs today
import { burst, defineConfig } from "@leivaa21/stampede";

export default defineConfig({
  // Runs once, on the main thread, before any load. Its return value reaches every worker by
  // structured clone, so it must be plain data — an id, not a client.
  setup: async () => {
    const res = await fetch("http://localhost:5210/shows", { method: "POST" });
    const { showId, seatId } = (await res.json()) as { showId: string; seatId: string };
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

      // Named claims about every response, counted pass/fail and printed as a row.
      checks: {
        oneWinnerOrConflict: (res) => res.status === 201 || res.status === 409,
      },

      // Counters and distributions a check cannot express. Merged across every worker thread.
      onResponse: (res, record) => {
        if (res.status === 201) record.count("reserved201");
      },
    },
  },

  // Runs after the storm. This is where the invariant is *proven* rather than observed —
  // "exactly one seat sold" is a claim about the run, and only askable once it is over.
  teardown: async ({ showId, seatId }) => {
    const res = await fetch(`http://localhost:5210/shows/${showId}/seats/${seatId}`);
    const seat = (await res.json()) as { soldCount: number };
    if (seat.soldCount !== 1) throw new Error(`double sell: ${String(seat.soldCount)} sold`);
  },

  thresholds: [
    { name: "exactly one buyer wins", assert: (s) => s.scenarios[0]!.counters.reserved201 === 1 },
    {
      name: "every response was a win or a conflict",
      assert: (s) => s.scenarios[0]!.checks.oneWinnerOrConflict?.failed === 0,
    },
    {
      name: "p99 under 250ms",
      assert: (s) => (s.scenarios[0]!.latencyMs?.p99Ms ?? Infinity) < 250,
    },
  ],
});
```

Every buyer above wants **the same seat**. To give each one a seat of their own, take the request's
ordinal — it is the **run's**, not the worker's, so four threads still produce 500 distinct seats:

```ts
scenarios: {
  hotShow: {
    profile: constantRate({ ratePerSecond: 250, durationMs: 2_000 }),
    // `ordinal % length`, so a run longer than the seat list wraps instead of sending `undefined`.
    request: ({ showId, seatIds }, ordinal) => ({
      method: "POST",
      url: `http://localhost:5210/shows/${showId}/reservations`,
      body: { seatIds: [seatIds[ordinal % seatIds.length]] },
    }),
    checks: { created: (res) => res.status === 201 },
  },
},
```

```bash
stampede run scenarios.ts                      # live TUI
stampede run scenarios.ts --report out.md --ci # headless, thresholds → exit code
```

A violated invariant **fails CI** (exit `1`) instead of printing a red number.

## Quickstart

```bash
pnpm install
pnpm dev -- run scenarios.ts                    # live dashboard
pnpm dev -- run scenarios.ts --report out.md    # + a report to paste into a README
pnpm dev -- run scenarios.ts --ci               # no dashboard, for CI
```

```
stampede · 3.0s · in flight ≤ 9
  theStampede
    ████████████████████████ 360/360 · 355 answered
    rate 120/s asked · 120/s so far
    p50 41.2ms · p99 44.7ms · queued p99 45.7ms
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
requested rate are always reported. If the tool can't keep up, the report says so. Every rounding
errs away from flattering the target — percentiles report the top of their bucket, a clamped value
is a labelled lower bound rather than a bare number, and a scenario that recorded nothing **fails the
run** instead of quietly passing its thresholds.

## Proving the numbers

An instrument cannot validate itself, and `pnpm test` cannot either — the fake clock in those tests
is agreed on by both the implementation and the assertion, so a shared wrong assumption passes
twice. So there is a second gate:

```bash
pnpm gate:two
```

It starts a reference server — fixed delay, bounded concurrency, queueing the rest, **selling seats
at most once each** and keeping its own count of everything — then drives seven runs against it
through the real system clock and real HTTP, checking stampede's numbers against the server's.
**Non-zero exit if any claim fails.** Real output:

**It can measure a stopwatch.** A 50ms target reads p50 52.4ms, and the server's own request count
matches what stampede says it sent.

**A target slower than the load offered** — 200ms per request, 10 slots, asked for 200rps:

```
    achieved rate — stampede vs target        200 rps vs 50 rps
    dispatched / dropped / errors             600 / 0 / 0
    latency p50 / p99 (the target)            3055.6ms / 5910.5ms
```

It dispatched all 600 while the target completed 390, and reported **p99 5910ms against a 200ms
isolated service time** — 30×. A closed-loop generator throttles itself here and publishes the 200ms
as though it were the user's experience.

**The generator itself as the bottleneck** — asking 50,000rps from one thread:

```
    achieved rate — stampede vs target        6181 rps vs 6271 rps
    dispatched / dropped / errors             12698 / 87302 / 0
    latency p50 / p99 (the target)            40.6ms / 162.9ms
    scheduledLatency p50 / p99 (D1-01)        124.5ms / 241.3ms
    schedule lag max (own backlog)            130.0ms
```

It admits **6,181rps of the 50,000 requested**, counts **87,302 drops**, and puts its own 130ms
backlog into `scheduledLatency` — 241ms against a raw 163ms. A tool that reported the 163ms would be
describing a machine that was never under that load.

**The worker pool, cross-checked by the target itself**: 4 threads, 480 scheduled, 480 dispatched,
**480 received by the server**, accounting balanced, zero out-of-order snapshots. A merge bug cannot
fool an independent observer.

**The invariants, not just the percentiles.** The last two runs are
[open-ticket](https://github.com/leivaa21/open-ticket)'s load contract, produced against a target
that counts seats for itself:

```
RUN 6 — contract run 1: 200 buyers, one seat, exactly one wins
    201s counted by stampede                  1
    seats the target says it sold             1
    check oneWinnerOrConflict                 200 pass · 0 fail · 0 broken

RUN 7 — contract runs 2 & 4: 200 buyers, 200 distinct seats, 4 threads
    201s counted by stampede                  200
    seats the target says it sold             200
    projection lag — p50 / p99 / max          240.1ms / 451.1ms / 461.1ms
    target's own max behind                   462ms
```

Run 7 is the one that cannot be faked. Four threads that restarted their numbering would send four
buyers to the same seat, and the target would answer three of them `409` — so the seat count is a
verdict on the ordinal mapping delivered by something that is not stampede. Break
`shardIndex + ordinal * shardCount` and the gate says so:

```
    check created                             50 pass · 150 fail · 0 broken
    FAIL  the target sold one seat per buyer, no collisions — 50 distinct seats sold
```

And the `behindMs` the config recorded through `onResponse` — merged across four worker threads —
lands within a millisecond of the lag the target measured on itself.

## Status

**M1 and M2 are complete.** Mergeable metrics core · open-loop engine · worker pool · TS config
loading · real HTTP transport · `stampede run` with setup/teardown, thresholds and exit codes ·
markdown report · live dashboard — and, from M2, named per-response **checks** counted three ways,
**custom counters and trends** merged across worker threads, and **per-request variation** keyed on
the run's ordinal. **504 tests**, zero known vulnerabilities, gate two green across seven runs.

**Next (M3): SSE / long-lived streaming requests** — open-ticket's contract run 5. Two debts M2
surfaced are named rather than forgotten: there is no way to express a bounded-cardinality counter
(ask for 600 names and the run fails telling you to use fewer), and `request()` is documented as
pure but not enforced.

**Not published to npm yet.** Install from source; `@leivaa21/stampede` is reserved.

**Deferred on purpose:** SSE / long-lived streaming requests, distributed workers, protocols beyond
HTTP(S), a cloud service, a scripting DSL. Say no on purpose.

Built as the instrument for [open-ticket](https://github.com/leivaa21/open-ticket)'s published load
numbers — built the instrument, then used it to validate the architecture.

---

MIT © Adrián Leiva ([leivaa21](https://github.com/leivaa21)) · part of
[whos.leivaa.dev](https://whos.leivaa.dev)

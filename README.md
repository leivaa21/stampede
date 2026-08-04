# stampede

A load-testing CLI that proves **invariants**, not just percentiles. Point it at an HTTP API,
describe scenarios in typed TypeScript, and get a live terminal dashboard plus a paste-ready
markdown report — with named checks, custom counters merged across worker threads, and thresholds
that decide the exit code.

```bash
stampede run scenarios.ts --report out.md --ci
```

> **`0`** every threshold held · **`1`** your system broke an invariant · **`2`** the run itself
> failed. A violated invariant fails CI instead of printing a red number.

---

**Contents** — [Install](#install) · [Quickstart](#quickstart) · [The CLI](#the-cli) ·
[Writing scenarios](#writing-scenarios) · [Arrival profiles](#arrival-profiles) ·
[Checks](#checks) · [Counters and trends](#counters-and-trends) ·
[Keyed counters](#counters-with-a-declared-key-space) · [Thresholds](#thresholds) ·
[setup and teardown](#setup-and-teardown) · [Tuning a run](#tuning-a-run) ·
[Reading the output](#reading-the-output) · [Gotchas](#gotchas) ·
[Programmatic use](#programmatic-use) · [Why it exists](#why-it-exists) ·
[Proving the numbers](#proving-the-numbers) · [Architecture](#architecture) · [Status](#status)

## Install

Requires **Node 24+**. Scenario configs are TypeScript loaded by Node's own type-stripping — no
build step, no bundler, no dependency.

```bash
# Once published:
pnpm add -D @leivaa21/stampede
npx stampede run scenarios.ts

# Today — from source:
git clone https://github.com/leivaa21/stampede && cd stampede
pnpm install && pnpm build
node dist/cli.js run /path/to/scenarios.ts
```

## Quickstart

Write `scenarios.ts`:

```ts
import { constantRate, defineConfig } from "@leivaa21/stampede";

export default defineConfig({
  scenarios: {
    health: {
      profile: constantRate({ ratePerSecond: 50, durationMs: 5_000 }),
      request: () => ({ url: "http://localhost:3000/health" }),
      checks: {
        ok: (res) => res.status === 200,
      },
    },
  },

  thresholds: [
    {
      name: "p99 under 250ms",
      assert: (s) => (s.scenarios[0]!.latencyMs?.p99Ms ?? Infinity) < 250,
    },
    { name: "nothing failed", assert: (s) => s.scenarios[0]!.checks.ok?.failed === 0 },
  ],
});
```

Run it:

```bash
stampede run scenarios.ts
```

```
stampede · 5.0s · in flight ≤ 15
  health
    ████████████████████████ 250/250 · 250 answered
    rate 50/s asked · 50/s so far
    p50 1.9ms · p99 42.9ms · queued p99 43.7ms
```

…and when it finishes, the same numbers as a summary plus a verdict:

```
run finished in 5.0s · peak in flight ≤ 15 (sum of per-thread peaks)

  health
    requests    250 scheduled · 250 sent · 250 answered
    rate        50/s requested · 50/s achieved
    latency     p50 1.9ms · p95 35.8ms · p99 42.9ms
    as queued   p50 2.4ms · p95 36.4ms · p99 43.7ms
    backlog     3.4ms max — the generator's own lateness, not the target's
    check       PASS  ok
thresholds
  PASS    p99 under 250ms
  PASS    nothing failed
```

250 requests at a steady 50/s, every response checked, and a process that exits non-zero if either
threshold fails. Everything below is how to say more than that.

## The CLI

```
stampede run <scenarios.ts>                   run the scenarios in a config file
stampede run <scenarios.ts> --workers 4       override the worker-thread count
stampede run <scenarios.ts> --report out.md   write a markdown report
stampede run <scenarios.ts> --ci              no live dashboard, even on a terminal
stampede --help | --version
```

| Flag              | Default          | What it does                                                              |
| ----------------- | ---------------- | ------------------------------------------------------------------------- |
| `--workers <n>`   | cores − 1, min 1 | Threads to split the schedule across. Overrides the config's `workers`.   |
| `--report <path>` | none             | Writes a markdown report — tables meant to be pasted into a PR or README. |
| `--ci`            | off when a TTY   | Suppresses the live dashboard. The final summary still prints.            |

**Exit codes** are the contract CI acts on:

| Code | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| `0`  | Every declared threshold held.                                                                  |
| `1`  | A threshold was violated, or `teardown()` threw — **your system** broke an invariant.           |
| `2`  | The run itself failed: bad config, unreachable target, nothing measured, or a **broken check**. |

The `1`/`2` split is deliberate. Exit `1` is a claim about the system under test; exit `2` says
stampede could not make a claim at all — so a typo in a predicate never gets reported as your
service double-selling a seat.

## Writing scenarios

`defineConfig` is the whole API. There is no scripting language: a profile is a function call, a
request is an object, a threshold is a typed predicate, and your editor autocompletes all of it.

```ts
export default defineConfig({
  setup: async () => ({ showId: "abc" }), // once, main thread, before any load
  scenarios: {/* one or more, run concurrently, each with its own metrics */},
  teardown: async (state) => {
    // once, main thread, after the storm
    /* prove the invariant here */
  },
  thresholds: [/* named claims about the whole run */],

  workers: 4, // default: cores − 1
  maxInFlight: 1_000, // default: 1000
  drainTimeoutMs: 30_000, // default: 30s
});
```

A **scenario** is a name, an arrival profile, and a request builder:

```ts
scenarios: {
  reads: {
    profile: constantRate({ ratePerSecond: 200, durationMs: 10_000 }),
    request: (state, ordinal) => ({
      method: "GET",
      url: `http://localhost:3000/shows/${state.showId}/seats`,
      headers: { authorization: `Bearer ${state.token}` },
    }),
  },
}
```

`request(state, ordinal)` is called **once per dispatch**:

- **`state`** is whatever `setup()` returned.
- **`ordinal`** is the request's position **in the whole run**, from `0` — global, not per-worker,
  so four threads still produce N distinct values. This is what makes "N buyers, N distinct seats"
  expressible: `seatIds: [seats[ordinal % seats.length]]`. Ignore it and every request is identical,
  which is the namesake run.

It must be a **pure function of `(state, ordinal)`** — every worker gets its own structured clone of
the state, so a builder that consumes shared state (`state.seats.pop()`) hands four threads the same
four values. If it throws, that request is counted as `not built` and the run continues.

What it returns:

```ts
{ url: string, method?: string, headers?: Record<string, string>, body?: unknown }
```

A string `body` is sent as-is; anything else is JSON-encoded and given a JSON content type.

## Arrival profiles

Profiles decide **when** requests go out. They are pure and lazy, and are evaluated when the module
is imported — before `setup()` runs — so they cannot read setup state.

```ts
import { burst, constantRate, ramp, stages } from "@leivaa21/stampede";

constantRate({ ratePerSecond: 100, durationMs: 30_000 });
ramp({ fromRatePerSecond: 10, toRatePerSecond: 500, durationMs: 60_000 });
burst({ count: 500 }); // all at t = 0
stages(
  // back to back
  ramp({ fromRatePerSecond: 0, toRatePerSecond: 200, durationMs: 10_000 }),
  constantRate({ ratePerSecond: 200, durationMs: 60_000 }),
);
```

`burst` is the namesake: 500 requests at the same instant, which is how you make N clients race for
one row.

**Arrivals are open-loop.** stampede does not wait for a response before sending the next request —
if your target slows down, the schedule keeps going and the lateness lands in the numbers rather
than hiding in them. See [Why it exists](#why-it-exists).

## Checks

A check is a **named predicate over one response**, counted and printed as a row.

```ts
checks: {
  oneWinnerOrConflict: (res) => res.status === 201 || res.status === 409,
  isJson: (res) => res.headers["content-type"]?.startsWith("application/json") === true,
}
```

The response is `{ status: number, headers: Record<string, string>, text: string }` — `text` is the
body as a string, always read.

Name the **claim**, not the expression: `oneWinnerOrConflict` beats `status2xxOr409`, because the
name is what a failing CI job prints.

Checks have **three** outcomes, not two:

| Outcome    | Meaning                          | Effect                                                   |
| ---------- | -------------------------------- | -------------------------------------------------------- |
| **pass**   | returned `true`                  | —                                                        |
| **fail**   | returned `false`                 | Your target broke the claim. Threshold-facing, exit `1`. |
| **broken** | threw, or returned a non-boolean | _Your predicate_ is wrong. Fails the run, exit `2`.      |

That third state exists because a typo in a check must never be reported as your service violating
an invariant — it sends someone hunting a race condition that was never there.

Checks must be **synchronous**. `async (res) => …` is rejected at startup: it returns a promise,
which is truthy and never `false`, so every check would pass forever.

A scenario may declare at most **64** checks — each one reserves a slot in the same metric budget
your own counters draw on, so an unbounded number would starve them and then blame the counters.

## Counters and trends

A check answers yes or no. `onResponse` is for everything else, and runs once per response:

```ts
onResponse: (res, record) => {
  if (res.status === 201) record.count("reserved201");
  if (res.status === 409) record.count("conflicts");

  const body = JSON.parse(res.text) as { behindMs?: number };
  if (typeof body.behindMs === "number") record.recordMs("behindMs", body.behindMs);
},
```

- **`record.count(name, by = 1)`** — a monotonic counter, merged across every worker thread.
- **`record.recordMs(name, valueMs)`** — a distribution, so you get p50/p99/max rather than a total.

Both land on the scenario's summary, in the report, and in reach of a threshold.

Keep the **names bounded**: one counter per outcome is fine, one per seat id is a cardinality bomb.
The caps are 512 counters, 512 checks and 32 distributions per scenario, and a run that exceeds them
**fails** rather than silently dropping recordings — a threshold reading a name that was refused
would otherwise read a confident `0`.

Like checks, `onResponse` must be synchronous, and a throw is counted rather than allowed to end the
run.

### Counters with a declared key space

A plain counter per dimension value — one per endpoint path, one per status code — is a
**cardinality bomb**: the per-scenario cap is 512 names, and a run that exceeds it fails rather
than silently dropping recordings. Declare the key space instead, and the cardinality is bounded
before a single request goes out:

```ts
scenarios: {
  reads: {
    profile: constantRate({ ratePerSecond: 200, durationMs: 10_000 }),
    request: (state) => ({ url: state.url }),

    counters: {
      byStatus: { keys: ["2xx", "4xx", "5xx"] },
    },

    onResponse: (res, record) => {
      record.countKeyed("byStatus", bucketOf(res.status));
    },
  },
}
```

```
counter     byStatus  2xx 4821 · 4xx 179 · 5xx 0 · other 0
```

- A key you **did** declare goes to its own slot.
- A key you **did not** goes to `other`, which is implicit, always present, and always reserved.
  Nothing is ever dropped — and a non-zero `other` is the signal your key space is wrong.
- Naming a counter you never declared is refused and **fails the run** (exit `2`). There is no
  bounded slot to put it in, and inventing one is the thing declaring exists to prevent.

Thresholds read them nested, in the shape you declared:

```ts
{ name: "no 5xx", assert: (s) => s.scenarios[0]!.keyedCounters.byStatus!["5xx"] === 0 }
```

Every declared key is present even if it never fired, so `["5xx"] === 0` means _none happened_
rather than _the key is missing_.

**Limits.** 64 keys per counter, and the whole scenario's reservations — stampede's own counters,
one per check, and every key plus its `other` — must fit the 512-name budget. Exceeding it is a
**startup** error with the arithmetic shown, not a surprise at the end of the run.

**Why you declare them.** The alternative is a top-N sketch that keeps the heaviest keys and folds
the rest away, needing no advance knowledge. Those merge _approximately and order-dependently_ — two
runs merging the same worker results in a different order could publish different numbers. That is
the one property this tool does not trade away, so the key space is something you write down.

## Thresholds

A threshold is a **named claim about the whole run**, and it decides the exit code.

```ts
thresholds: [
  { name: "exactly one buyer wins", assert: (s) => s.scenarios[0]!.counters.reserved201 === 1 },
  { name: "no double sells", assert: (s) => s.scenarios[0]!.checks.noDoubleSell?.failed === 0 },
  { name: "p99 under 250ms", assert: (s) => (s.scenarios[0]!.latencyMs?.p99Ms ?? Infinity) < 250 },
  { name: "kept up", assert: (s) => (s.scenarios[0]!.achievedRatePerSecond ?? 0) >= 190 },
];
```

What the `summary` gives you:

```ts
summary.elapsedMs
summary.maxObservedInFlight
summary.scenarios[i].{
  name,
  scheduledCount, dispatchedCount, droppedCount, requestErrorCount,
  responseCount, errorCount, abandonedCount,
  requestedRatePerSecond, achievedRatePerSecond,
  latencyMs, scheduledLatencyMs, scheduleLagMs,
  counters, checks, trends,
  brokenObservations, refusedRecordings,
}
```

Distributions — `latencyMs`, `scheduledLatencyMs`, `scheduleLagMs`, and anything in `trends` — are:

```ts
{
  (count,
    minMs,
    maxMs,
    meanMs,
    p50Ms,
    p95Ms,
    p99Ms,
    p999Ms,
    overflowCount,
    saturated,
    isLowerBound);
}
```

…or **`undefined`** when nothing was recorded. That is deliberate: it stops `(s.p99Ms ?? 0) < 250`
letting a scenario that never ran pass its own threshold.

Two latency distributions, and the difference is the point:

- **`latencyMs`** — send → response. What your target took.
- **`scheduledLatencyMs`** — _scheduled instant_ → response. What a user waiting in line
  experienced, generator backlog included. **This is the headline number.**

A predicate that throws or returns a non-boolean is a broken claim, not a violated one: exit `2`,
with the threshold named.

## setup and teardown

```ts
setup: async () => {
  const res = await fetch("http://localhost:3000/shows", { method: "POST" });
  const { showId, seatId } = (await res.json()) as { showId: string; seatId: string };
  return { showId, seatId }; // structured-cloneable data — an id, not a client
},

teardown: async ({ showId, seatId }) => {
  const res = await fetch(`http://localhost:3000/shows/${showId}/seats/${seatId}`);
  const seat = (await res.json()) as { soldCount: number };
  if (seat.soldCount !== 1) throw new Error(`double sell: ${String(seat.soldCount)} sold`);
},
```

`setup()` runs **once, on the main thread**, before any load. Its return value reaches every worker
by structured clone — functions cannot cross that boundary, so create the show here and keep the
client inside the scenario.

`teardown()` runs **once, after the storm and after the drain**. It is an **assertion hook, not a
cleanup hook**: this is where an invariant gets _proven_ rather than observed, because "exactly one
seat sold" is a question you can only ask once the race is over. Throwing fails the run with exit
`1`, like a violated threshold — because that is what it is.

It does not run when the load could not be generated at all. Anything that must be cleaned up
regardless belongs in the harness around `stampede`.

## Tuning a run

| Option           | Default   | When to change it                                                                                                                                        |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers`        | cores − 1 | Raise to generate more load. The schedule is split by stride, so shards reproduce the single-threaded run exactly.                                       |
| `maxInFlight`    | `1000`    | The cap on outstanding requests, run-wide. Open-loop dispatch against a dead target is otherwise unbounded memory. Breaches are **dropped and counted**. |
| `drainTimeoutMs` | `30_000`  | How long to keep waiting after the last dispatch. Whatever is still outstanding is counted as `abandoned` and left out of the percentiles.               |

Drops against a healthy target mean `maxInFlight` is too low. Abandoned requests mean
`drainTimeoutMs` is — or that your target really is that slow, which is worth knowing.

## Reading the output

```
run finished in 5.0s · peak in flight ≤ 12 (sum of per-thread peaks)

  theStampede
    requests    500 scheduled · 500 sent · 500 answered
    rate        n/a — a burst asks for a count, not a rate
    latency     p50 170.6ms · p95 237.7ms · p99 238.1ms
    as queued   p50 220.7ms · p95 302.6ms · p99 307.2ms
    backlog     71.2ms max — the generator's own lateness, not the target's
    check       PASS  oneWinnerOrConflict
    counter     reserved201 = 1
thresholds
  PASS    exactly one buyer wins
  PASS    every response was a win or a conflict
```

Lines you only see when they are non-zero, and what each one tells you:

| Line                               | Meaning                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `shortfall … N dropped`            | The in-flight cap refused them. Raise `maxInFlight`.                       |
| `shortfall … N not built`          | Your `request()` threw. The target was never asked — fix the config.       |
| `shortfall … N failed`             | Transport-level failures: refused, DNS, timeout. Counted, never timed.     |
| `shortfall … N abandoned`          | Still outstanding at the drain deadline. Left out of the percentiles.      |
| `check BROKEN n <name>`            | That predicate threw or returned a non-boolean. Exit `2`.                  |
| `⚠ N recordings refused`           | More distinct metric names than the caps allow. Some are missing entirely. |
| `⚠ … percentiles are lower bounds` | Samples exceeded the histogram ceiling (67s). The numbers understate.      |

Every rounding errs **away** from flattering your target: percentiles report the top of their
bucket, a clamped value is a labelled lower bound rather than a bare number, and a scenario that
recorded nothing **fails the run** instead of quietly passing its thresholds.

`--report out.md` writes the same numbers as markdown tables, with the run's own provenance
(version, config path, worker count, settings, timestamp) so a pasted table cannot be mistaken for a
different run.

## Gotchas

- **Erasable syntax only.** Node strips types without compiling them, so configs cannot use `enum`,
  parameter properties, or `namespace`. stampede translates the resulting Node error into a message
  naming the file and the construct.
- **`setup()` returns data, not objects with methods** — it crosses a worker boundary by structured
  clone.
- **`request` must be pure** in `(state, ordinal)`.
- **No `async` checks or `onResponse`** — refused at startup, with the offender named.
- **Metric names are bounded**, and the `stampede.` prefix is reserved for the engine's own counters.
- **Scenario names must be unique** — they namespace the metrics, so duplicates would silently
  average two different things together.

## Programmatic use

The engine has no UI imports and is exported, if you want to drive it yourself:

```ts
import { constantRate, httpTransport, runDispatch, systemClock } from "@leivaa21/stampede";

const { summary } = await runDispatch(
  {
    scenarios: [
      {
        name: "reads",
        profile: constantRate({ ratePerSecond: 50, durationMs: 2_000 }),
        requestFor: () => ({ url: "http://localhost:3000/" }),
        checks: { ok: (res) => res.status === 200 },
      },
    ],
    maxInFlight: 500,
  },
  { clock: systemClock, transport: httpTransport },
);

console.log(summary.scenarios[0]?.latencyMs?.p99Ms);
```

`runPool` does the same across worker threads, and `renderMarkdownReport` turns a summary into the
report the CLI writes.

---

## Why it exists

Most load tools answer _"how fast is it?"_. The question that actually blocks a launch is _"is it
still correct when 500 people hit the same row at once?"_ — and that is a claim about a **run**, not
a request.

The measurement side rests on one decision: **arrivals are open-loop, and latency is timed from the
_scheduled_ instant**. A closed-loop generator waits for a response before sending the next request,
so when your target slows down the generator slows with it — latency samples come
disproportionately from healthy moments and p99 flatters the system exactly when it shouldn't. That
is **coordinated omission**, and it is why a tool can report 200 ms while your users wait five
seconds. stampede sends on schedule regardless, and the time it spends backed up lands _in_ the
number instead of being hidden by it.

Honesty is a design rule, not a feature: dropped requests, histogram overflow, request-build
failures and achieved-vs-requested rate are always reported. If the tool cannot keep up, the report
says so — and every rounding errs _away_ from flattering the target.

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

- **Open-loop arrivals, latency timed from the _scheduled_ instant** — see above.
- **HDR-style bucketed histograms.** Merging across workers has to be lossless and
  order-independent — elementwise addition. t-digest merges are approximate _and_ order-dependent,
  so published numbers would depend on which worker finished first.
- **Node 24 native type-stripping** for scenario configs. No bundler, no build step, no dependency,
  and identical behaviour in the main thread and in workers — which the architecture depends on.
- **Thresholds are named typed predicates**, not a string mini-language. The TS config is the DSL;
  the threshold's name is what the CI failure prints.

## Proving the numbers

An instrument cannot validate itself, and `pnpm test` cannot either — the fake clock in those tests
is agreed on by both the implementation and the assertion, so a shared wrong assumption passes
twice. So there is a second gate:

```bash
pnpm gate:two
```

**A manual milestone gate, not a CI job** — it spawns servers and leans on real timing, which a
shared runner would make flaky, and a flaky gate is one people learn to ignore. It is run before a
milestone is called done, and the numbers below are from a 16-core dev box; a smaller machine will
report different throughput and the same _relationships_, which are what the claims are about.

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
    achieved rate — stampede vs target        1073 rps vs 1074 rps
    dispatched / dropped / errors             2606 / 97394 / 0
    latency p50 / p99 (the target)            203.1ms / 814.1ms
    scheduledLatency p50 / p99 (D1-01)        559.6ms / 1031.7ms
    schedule lag max (own backlog)            489.2ms
```

It admits **about a thousand rps of the 50,000 requested**, counts **97,394 drops**, and puts its own
489ms backlog into `scheduledLatency` — 1032ms against a raw 814ms. A tool that reported the 814ms
would be describing a machine that was never under that load.

The absolute throughput here is the least reproducible number in the gate — three consecutive runs
on the same idle box gave 995, 1302 and 1073rps, because it is dominated by per-response work in the
host process. Read the _relationships_, which is what the claims assert: achieved ≪ requested, every
undispatched instant counted rather than absorbed, and the backlog landing in `scheduledLatency`
rather than being hidden. (An earlier version of this page quoted 6,181rps from a run predating
M2 — reading the response body for checks costs real time per response, and nobody re-measured. The
gate now runs on every milestone for exactly that reason.)

**The worker pool, cross-checked by the target itself**: 4 threads, 480 scheduled, 480 dispatched,
**480 received by the server**, nothing dropped, accounting balanced, zero out-of-order snapshots.
A merge bug cannot fool an independent observer.

**The invariants, not just the percentiles.** The last two runs are
[open-ticket](https://github.com/leivaa21/open-ticket)'s load contract, produced against a target
that counts seats for itself:

```
RUN 6 — contract run 1: 200 buyers, one seat, exactly one wins
    PASS  exactly one buyer won — 1 of 200
    PASS  the target issued exactly one sale, and N−1 conflicts — 1 sold + 199 conflicts,
          counted by the target itself

RUN 7 — contract runs 2 & 4: 200 buyers, 200 distinct seats, 4 threads
    lag samples merged / expected             200 / 200
    projection lag — p50 / p99 / max          253.1ms / 454.1ms / 464.1ms
    target's own max behind                   464ms

    PASS  the target sold one seat per buyer, no collisions — 200 distinct seats sold
    PASS  every recorded lag sample survived the merge across four threads — 200 of 200
    PASS  the projection really did fall behind, so there was a lag to measure — 464ms
          peak, against a 125ms floor
    PASS  the recorded projection lag matches the target's own peak — 464.1ms recorded
          vs 464ms the target measured itself
    PASS  the schedule really was split evenly across four threads — 50/50/50/50 each
```

Run 7 is the one that cannot be faked. Four threads that restarted their numbering would send four
buyers to the same seat, and the target would answer three of them `409` — so the seat count is a
verdict on the ordinal mapping delivered by something that is not stampede. Break
`shardIndex + ordinal * shardCount` and the gate says so:

```
    check created                             50 pass · 150 fail · 0 broken
    FAIL  the target sold one seat per buyer, no collisions — 50 distinct seats sold
```

And the `behindMs` the config recorded through `onResponse` is cross-checked twice: **every one of
the 200 samples survived the merge** across four worker threads, and the peak agrees with the one
the target latched for itself to within the histogram's own rounding — under 0.1 % plus a
millisecond, a rule rather than a constant, so it encodes no assumption about how large the peak
gets.

The sample count is the claim that matters. Shards interleave by stride, so every worker holds
samples spread across the whole run — losing an entire worker's trend moves the peak by under a
millisecond and would sail past a peak-only check. It does not sail past this one.

## Status

**M1 and M2 are complete.** Mergeable metrics core · open-loop engine · worker pool · TS config
loading · real HTTP transport · `stampede run` with setup/teardown, thresholds and exit codes ·
markdown report · live dashboard — and, from M2, named per-response **checks** counted three ways,
**custom counters and trends** merged across worker threads, and **per-request variation** keyed on
the run's ordinal. **546 tests**, zero known vulnerabilities, gate two green across seven runs.

**Next (M3): SSE / long-lived streaming requests** — open-ticket's contract run 5. One debt M2
surfaced is still open: `request()` is documented as pure but not enforced. Bounded-cardinality
counters landed in M2.5 — declare a key space and use `record.countKeyed`.

**Not published to npm yet.** Install from source; `@leivaa21/stampede` is reserved.

**Deferred on purpose:** SSE / long-lived streaming requests, distributed workers, protocols beyond
HTTP(S), a cloud service, a scripting DSL. Say no on purpose.

Built as the instrument for [open-ticket](https://github.com/leivaa21/open-ticket)'s published load
numbers — built the instrument, then used it to validate the architecture.

---

MIT © Adrián Leiva ([leivaa21](https://github.com/leivaa21)) · part of
[whos.leivaa.dev](https://whos.leivaa.dev)

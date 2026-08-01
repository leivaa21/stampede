# Decisions

## 2026-07-30 — Published as `@leivaa21/stampede`; the repo, the binary and the name stay `stampede`

**Context:** npm `stampede` is taken by a real (dormant since 2022) web framework with 162
published versions, and `stampede-cli` by its companion CLI. Unscoped alternatives were available
(`thundering-herd`, `hoofbeat`, `loadherd`).
**Decision:** publish scoped as **`@leivaa21/stampede`**. GitHub repo `leivaa21/stampede`, binary
`stampede`, and the name everywhere it already appears stay unchanged.
**Rationale:** the name is load-bearing beyond this repo — it is the namesake of open-ticket's
headline run, and it is written into the workspace registry and open-ticket's M4/M5 design docs.
The scope costs one prefix in the install string; renaming costs a sweep across three repos and the
loss of "the stampede run, measured by stampede".
**Consequences:** `publishConfig.access: "public"` is required for a scoped package. Diverges from
`envpact`, which is unscoped — the precedent is "ship to npm", not "ship unscoped".

## 2026-07-30 — Open-loop arrivals; latency measured from the scheduled instant

**Context:** the two load models are genuinely different engines. Closed-loop (N virtual users, each
awaiting its own response) matches how the contract is worded; open-loop (dispatch on a schedule
regardless of in-flight responses) does not.
**Decision:** **open-loop**, with composable arrival profiles (`constantRate`, `ramp`, `burst`), and
latency recorded from the **scheduled** dispatch instant rather than the actual send.
**Rationale:** closed-loop hides **coordinated omission** — a slow target throttles the generator, so
latency samples are drawn disproportionately from healthy moments and the reported p99 flatters the
system exactly when the truth matters. For a tool whose pitch is _prove your numbers_, that is
disqualifying. Measuring from the scheduled instant is what makes the correction real rather than
nominal: generator backlog lands in the number instead of vanishing from it.
**Consequences:** open-loop against an unresponsive target is unbounded memory, so a `maxInFlight`
cap is mandatory — and breaches are **dropped and counted**, never silently absorbed. Every run
reports achieved vs requested rate. Evenly-spaced (not Poisson) arrivals, chosen so a published
report reproduces.

## 2026-07-30 — HDR-style bucketed histograms; merge must be lossless and order-independent

**Context:** percentiles have to be computed per worker and merged at run end. Candidates:
fixed-layout bucketed histogram (HDR style), t-digest, exact sample retention.
**Decision:** **HDR-style bucketed histogram** — exponent × linear sub-buckets, 3 significant
digits, µs resolution to ~60s.
**Rationale:** mergeability is the binding constraint, and only the fixed layout makes merging
**elementwise addition** — exact, associative, commutative. t-digest merges are approximate _and_
order-dependent, so the same run would produce different published numbers depending on which worker
finished first; that is unacceptable in a report meant to be reproducible. Exact retention is
unbounded memory. Bounded cost: **17,408 `Int32` counts = 68 KiB** per histogram (1024 counts per
octave × 17 octaves to a 2²⁶ µs ≈ 67.1s ceiling), ≤0.1% error — measured worst case **0.0975%**,
swept across the full range.
**Consequences:** values above the ceiling are clamped **and counted as overflow**, with the count
printed — a silently clamped p99 is a lie. Percentiles report the **top** of the sample's bucket so a
latency is never under-reported; with overflow present the ceiling is returned as a documented lower
bound; and an empty histogram returns `undefined` rather than `0` — see the entry below on what a
threshold does with a scenario that recorded nothing.

## 2026-07-30 — Workers own their metrics; the main thread merges cumulative snapshots

**Context:** load generation is parallel across worker threads, but the claims ("exactly one 201")
are about the whole run, so per-worker metrics must aggregate correctly.
**Decision:** each worker owns a private metrics registry and posts **cumulative** snapshots on a
timer plus a final one at the end; the main thread keeps the latest snapshot per worker and
re-merges. No shared mutable state, no `SharedArrayBuffer` atomics.
**Rationale:** cumulative snapshots make aggregation **idempotent** — a dropped or duplicated message
cannot corrupt the total, which a delta protocol could. Shared-memory atomics would buy throughput
this tool does not need and cost correctness risk it cannot afford.
**Consequences:** slightly larger messages than deltas, at ~1 Hz — irrelevant. Schedule splitting
across workers is deterministic so runs reproduce — see the entry below for how. **Delayed** messages need one thing more than
cumulative snapshots: each carries a monotonic **sequence number** and the aggregator ignores
anything it has already superseded. Without it the property held only because a single `MessagePort`
preserves send order — an assumption a worker-protocol change could break silently, publishing a
mid-run snapshot as the final one.

## 2026-07-30 — TS scenario config loaded by Node 24 native type-stripping

**Context:** "the TS config is the DSL" is a headline feature, so config loading is the first thing a
user touches. Options: native type-stripping, bundling the config with esbuild on load, a
strip-then-fallback hybrid, or requiring precompiled JS.
**Decision:** **native type-stripping** — `import()` the user's `.ts` directly, no bundler, no build
step, no dependency. Verified against Node v24.12 before deciding, including a worker thread
importing the config and receiving setup state via `workerData`.
**Rationale:** zero dependencies in a tool whose pitch is a small readable codebase, instant startup,
and — the deciding factor — _identical_ behaviour in the main thread and in workers, which the
architecture depends on. The hybrid fallback was rejected for having two loading paths whose
divergence stays invisible until it isn't.
**Consequences:** **erasable syntax only** — no `enum`, no parameter properties, no `namespace`. Node
raises `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` naming the construct, so the CLI translates it into an
actionable error instead of a stack trace. And because functions cannot cross the worker boundary,
each worker imports the config itself: `setup()` runs once on the main thread and **must return
structured-cloneable data**, handed to every virtual user.

## 2026-07-30 — A run holds multiple concurrent scenarios, each with its own metrics

**Context:** open-ticket's contract run 3 is "heavy seat-map `GET`s **while** writes contend".
**Decision:** a run is a list of scenarios multiplexed onto the same workers, each with its own
arrival profile, histograms, counters, checks, and report section.
**Rationale:** the run is unsatisfiable with one scenario per run, and reporting read p99 averaged
with write p99 would destroy the exact asymmetry the measurement exists to show. Designing the
scheduler around a scenario list from the start costs little; retrofitting it costs the protocol.
**Consequences:** metric names are namespaced per scenario.

## 2026-07-30 — Thresholds are named typed predicates, not a string expression DSL

**Context:** thresholds decide the exit code, so they need to be both expressive and readable in a
CI failure. k6 uses a string mini-language (`http_req_duration: ["p(99)<250"]`).
**Decision:** a threshold is `{ name, assert }` — a human-readable name plus a typed predicate over
the merged run summary.
**Rationale:** the non-goals say _no scripting DSL — the TS config is the DSL_. A predicate needs no
parser, is autocompleted and type-checked against the summary shape, and its `name` is what the
report and the CI failure line print, which a parsed expression cannot express as well.
**Consequences:** exit codes distinguish **1** (an invariant was violated — your system) from **2**
(the run failed to execute — the tool or the config). CI needs to tell those apart.

## 2026-07-30 — Engine and TUI share nothing but a typed event stream

**Context:** the brief requires the engine to be usable programmatically, with no UI imports.
**Decision:** `src/engine/` emits typed events; the TUI renderer and the markdown reporter are two
independent consumers. Enforced with an ESLint import-boundary rule.
**Rationale:** a lint rule is the only version of this that survives contact with a deadline.
**Consequences:** the package ships two entries — `stampede` (CLI) and the library export.

## 2026-07-30 — A scenario that recorded nothing fails the run, before thresholds are evaluated

**Context:** D1-02 makes an empty histogram return `undefined` rather than `0`, because zero latency
is a lie about a run that measured nothing. That type then has to reach user threshold predicates.
**Decision:** a scenario that finishes with **zero recorded responses fails the run (exit 2)**, checked
before any threshold runs. The threshold-facing summary therefore exposes plain `number`s.
**Rationale:** if `number | undefined` reached user predicates, the obvious way to satisfy the
type-checker is `(s.scenarios.reads.p99 ?? 0) < 250` — and then **a scenario that never ran passes
its threshold**. That is exactly the lie the `undefined` was chosen to prevent, reintroduced by the
ergonomics of preventing it. The trap is best removed where it starts, not documented as a footgun.
Failing the _run_ rather than the _threshold_ is the honest classification: a load test whose
scenario never issued a response is broken, not violated.
**Consequences:** the summary projection is a separate read-only shape from the recording registry —
which the reviewer independently wanted anyway, since get-or-create on a read path let a mistyped
predicate inject a phantom scenario into the published report.

## 2026-07-30 — Metrics reporting semantics: every rounding errs away from flattering the target

**Context:** a bucketed histogram must choose what to report within a bucket, what to do when a
sample exceeds the ceiling, and what to do when an `Int32` bucket saturates. Each has a "nicer
number" answer and an honest one.
**Decision:** percentiles report the **top** of the sample's bucket (means use midpoints); with
overflow present the ceiling is returned as a **documented lower bound** carried alongside the value,
never as a bare number; a saturated bucket **drops the sample and latches a `saturated` flag** rather
than wrapping negative; and worker snapshots carry a monotonic **sequence number** so a delayed
message cannot rewind the aggregate.
**Rationale:** the tool's entire pitch is _prove your numbers_, so every one of these resolves toward
under-claiming rather than over-claiming. The sequence number is the one that isn't about rounding:
without it the "idempotent aggregation" property held only because a single `MessagePort` preserves
order — a transport assumption living in a different file from the guarantee that depended on it, and
one worker-protocol change away from silently publishing a mid-run snapshot as final.
**Consequences:** `mean` under overflow is a lower bound with an _unbounded_ error (999 fast requests
plus one 10-minute outlier reports 68ms against a true 601ms), so it travels with an `isLowerBound`
flag rather than as a plain number. `Trend` reuses `Histogram` behind an explicit `Ms` suffix so a
caller cannot mix ms and µs by accident.

## 2026-07-30 — Metric names are bounded, and refusals are counted rather than dropped

**Context:** the scenario API hands users the response with the metrics handle in scope, so
`counters.inc(res.headers["x-request-id"])` is a natural mistake rather than an exotic one. Every
distinct name becomes a `Map` entry in **every worker** and part of a structured clone crossing
`postMessage` at ~1 Hz; a distribution costs 68 KiB of buckets.
**Decision:** cap name **length** and **cardinality**, and split the failure mode by where the name
comes from:

- **Data-derived names** (metrics — counters, checks, distributions; 32 and 512 per registry) are
  **refused and counted**. They arrive mid-run, from responses, under load.
- **Config-derived identifiers** (scenario names) **throw**, at startup, before any load.

**Rationale:** an unbounded, target-influenced key space is the one place a load generator can be made
to exhaust its own memory by the system under test — and a load tester that dies mid-run publishes
nothing. For data-derived names, refusing beats throwing (a metric-name typo should not abort a
20-minute run) and beats dropping (a silently missing counter is the class of lie this repo keeps
ruling out); counting refusals is the same rule already applied to dropped requests and histogram
overflow. Config-derived names invert every one of those: the same config fails identically every
run, the failure costs nothing at startup, and silently dropping a scenario would cost an entire
report section with only a counter to explain it. Uniformity would have been the worse answer here.
**Consequences:** the cap is **per registry**, so a merged aggregate is bounded at `workers × cap`
rather than at `cap` — stated explicitly, because the types otherwise imply an invariant that merging
does not preserve. The caps bound the **recording** path: `fromSnapshot`/`parseRegistrySnapshot`
deliberately do not re-apply them, so restore is a faithful inverse of serialise rather than a second
policy point. Unreachable from a real producer (every worker shares one config), and documented at
the code rather than left implicit. `Map` (not a plain object) keys every named container, which also
removes any `__proto__`-style hazard from user-supplied names.

## 2026-07-31 — Shards are cut by stride, not by dividing the rate

**Context:** D1-03 originally said each worker would generate `rate / workers` with a phase offset,
and `burst(N)` would give each worker `N / workers` with the remainder spread over the first ones.
That is implementable for `constantRate`. It is awkward for `ramp`, whose instants come from
inverting an integral, and worse for `stages`, which composes profiles whose boundaries do not
divide evenly — each shape needs its own rule, and each rule is a fresh chance to lose or duplicate
a request.
**Decision:** shard `w` of `W` takes the instants at **indices `w, w + W, w + 2W, …`**. Every
profile is a sequence, so the split needs to know nothing about how the sequence was produced.
**Rationale:** the union of the shards is _exactly_ the original **by construction**, not by
arithmetic that happens to add up — there is no rounding to get wrong, and a profile shape added
later inherits the split for free. The cost is that each shard walks the whole sequence and keeps
one instant in `W`; generating an instant is a couple of multiplications with no allocation, so a
six-million-dispatch run costs each worker microseconds of skipping against a run measured in
minutes. Correctness by construction is worth that many times over.
**Consequences:** the in-flight budget is divided the same way, remainder to the lowest shards, and
a budget smaller than the worker count is refused before a thread spawns — a worker with no slots
would drop its whole share while the run reported a healthy cap. **A shard cannot borrow a
sibling's slack**, so drops appear slightly sooner than a perfectly shared budget would; that is the
price of never taking a lock on the dispatch path. The stride also loses the _global_ dispatch
ordinal (each shard re-counts from 0), which matters the moment per-request variation lands —
recoverable exactly as `shardIndex + localIndex * shardCount`, and noted at the code.

## 2026-07-31 — The HTTP transport follows no redirects, and adds nothing else

**Context:** the transport is the code every published latency number is measured around. `fetch`
ships with defaults — most notably **follow up to twenty redirect hops** — that are inherited by
simply not mentioning them.
**Decision:** `redirect: "manual"`. A 3xx is a response: timed like any other, reported as the
status it really was, and left to the scenario's own checks to judge. No retries, no connection
pooling knobs, nothing else.
**Rationale:** an inherited redirect policy is the most expensive kind, because it is invisible.
Behind an http→https 301 the default would fold an extra round trip and a TLS handshake into the p50
and attribute them to the endpoint under test, while a `status === 200` check passed for an endpoint
that actually answered 301. The transport's own comment already refused to add a redirect policy;
it was silently running one. Retries are refused for the same reason: a retry that turns two
failures into one success is a lie about the target.
**Consequences:** a user pointing at a redirecting URL sees the 3xx rather than the destination, and
has to point at the destination — noisier once, honest every time after. The response body is
drained inside the measured window, because stopping at the headers would report a streaming target
as far faster than any client of it experiences. `fetch` labels a _string_ body `text/plain` on its
own, so pre-serialised JSON needs an explicit header; passing the object and letting the transport
encode it is the path that does the right thing.

## 2026-07-31 — What each exit code means, and what teardown is for

**Context:** `stampede run` has to tell CI three different things apart, and the config author has to
know which hook does what.
**Decision:** **0** every threshold held · **1** a threshold was violated _or_ `teardown()` threw ·
**2** the run itself failed. `teardown()` is an **assertion** hook that runs only after a successful
storm; it is not a cleanup hook and does not run when the run failed. A threshold predicate that
_throws_ — or returns a non-boolean — is a **broken claim** (2), not a violated one (1). A scenario
that recorded no responses fails the run (2) before any threshold is evaluated, and a scenario whose
profile schedules **zero** requests is refused at config load.
**Rationale:** the split between 1 and 2 is the whole reason the codes exist — a broken install or a
config typo reporting as a failed invariant sends someone hunting a race condition that was never
there. Teardown throwing is a genuine invariant failure ("exactly one seat sold" can only be asked
after the storm), so it earns 1; a predicate throwing is the config's mistake, so it earns 2. And a
zero-request scenario had to be closed at load time because it slips past the "recorded nothing"
guard — it dispatched nothing, so nothing failed — and reaches the thresholds where
`(s.p99 ?? 0) < 250` passes: a green CI job for a load test that sent no load.
**Consequences:** teardown not running on failure means a `setup()` that created real state leaks it
when the pool fails; stated in the `teardown` JSDoc rather than left to be discovered. Rates like
`constantRate({ ratePerSecond: 2, durationMs: 100 })` now fail at startup with the arithmetic
spelled out, instead of running an empty test.

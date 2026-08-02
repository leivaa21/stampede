# Decisions

> Entries the code cites by tag — `(D1-01)`, `(D2-04)` — carry that tag in their heading. The
> milestone design docs in `docs/design/` introduce them; this file is where the reasoning lives.

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

## 2026-07-30 — [D1-01] Open-loop arrivals; latency measured from the scheduled instant

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

## 2026-07-30 — [D1-02] HDR-style bucketed histograms; merge must be lossless and order-independent

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

## 2026-07-30 — [D1-03] Workers own their metrics; the main thread merges cumulative snapshots

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

## 2026-07-30 — [D1-04] TS scenario config loaded by Node 24 native type-stripping

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

## 2026-07-30 — [D1-05] A run holds multiple concurrent scenarios, each with its own metrics

**Context:** open-ticket's contract run 3 is "heavy seat-map `GET`s **while** writes contend".
**Decision:** a run is a list of scenarios multiplexed onto the same workers, each with its own
arrival profile, histograms, counters, checks, and report section.
**Rationale:** the run is unsatisfiable with one scenario per run, and reporting read p99 averaged
with write p99 would destroy the exact asymmetry the measurement exists to show. Designing the
scheduler around a scenario list from the start costs little; retrofitting it costs the protocol.
**Consequences:** metric names are namespaced per scenario.

## 2026-07-30 — [D1-06] Thresholds are named typed predicates, not a string expression DSL

**Context:** thresholds decide the exit code, so they need to be both expressive and readable in a
CI failure. k6 uses a string mini-language (`http_req_duration: ["p(99)<250"]`).
**Decision:** a threshold is `{ name, assert }` — a human-readable name plus a typed predicate over
the merged run summary.
**Rationale:** the non-goals say _no scripting DSL — the TS config is the DSL_. A predicate needs no
parser, is autocompleted and type-checked against the summary shape, and its `name` is what the
report and the CI failure line print, which a parsed expression cannot express as well.
**Consequences:** exit codes distinguish **1** (an invariant was violated — your system) from **2**
(the run failed to execute — the tool or the config). CI needs to tell those apart.

## 2026-07-30 — [D1-07] Engine and TUI share nothing but a typed event stream

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

## 2026-08-01 — Live progress rides on every worker message, and is pulled rather than pushed

**Context:** PR 4 shipped the worker pool with **no** live-progress callback, and a comment arguing
against adding one: a mid-run merge held metrics from every worker but progress only from those that
had finished, so it published an empty run and then one whose dispatched count exceeded its
scheduled count. The comment said the fix was a protocol change belonging with the consumer that
would need it. The TUI is that consumer.
**Decision:** **every** worker message carries its sender's progress, not just the final one. The
dispatcher exposes a `LiveProgress` **handle the caller reads**, rather than a callback the loop
pushes into. Nothing is published until every worker has reported at least once.
**Rationale:** a push callback would fire once per dispatch batch — thousands of times a second — to
feed something that redraws a few times a second, and the dispatch loop's job is issuing requests on
schedule, not formatting. Withholding the first frame closes the remaining hole: merged progress is
a union over the workers heard from, so an early frame stated a fraction of the run's schedule _and_
of its requested rate, and the progress bar went backwards as later workers arrived. Under-reporting
a static fact the config already fixed is the same category of wrong as the bug the protocol change
was made to kill.
**Consequences:** the live view starts one snapshot interval late, which is the honest trade. A live
frame must **not** use `RunSummary.achievedRatePerSecond` — that divides by the profile's whole
configured window, which is right only at the end, and mid-run showed a run issuing exactly its
requested rate as a two-thirds shortfall for its entire duration. The dashboard derives its own rate
from elapsed time. A consumer that throws is isolated: a render bug must not abort a load test.

## 2026-08-02 — [D2-01] M2: the response body reaches user code, always

**Context:** checks, `onResponse` and open-ticket's contract run 4 (`behindMs`) all need what came
back, and `TransportResponse` carried only a status. Options: always decode, opt in per scenario,
infer from whether the scenario declares callbacks, or hand out a lazy `await response.text()`.
**Decision:** every response carries `{ status, headers, text }`, unconditionally. `text` is a
string; it is not JSON-parsed.
**Rationale:** the bytes are **already read** — `http-transport.ts` drains the body so the measured
window covers the whole response rather than stopping at the headers — so the new cost is decoding
and holding one string per in-flight response, bounded by `maxInFlight`. Opt-in costs nothing at
runtime and costs a user their first debugging session when a check reads `undefined`. The lazy
accessor is the one that actually loses something real: the read would land **outside** the measured
window, so latency would silently stop meaning what it means everywhere else — the one trade this
repo will not make. Parsing is left to the user because it costs on the hot path and throws on the
one response that is not JSON, which is the response a check most wants to catch.
**Consequences:** user callbacks run per response on the worker's hot path (see the throw rule
below). A very large body is held briefly; `maxInFlight` is the bound, as it is for everything else.

## 2026-08-02 — [D2-02] M2: `request(state, index)` carries the run's ordinal, not the shard's

**Context:** contract run 2 is N buyers across N _distinct_ seats. The engine carried one request
per scenario for its whole lifetime.
**Decision:** the request builder receives the dispatch ordinal, and that ordinal is **global to the
run**: `shardIndex + localIndex * shardCount`.
**Rationale:** `mergedSchedule` numbers dispatches from 0 within each shard, so four workers would
each build request 0, 1, 2 — and "N buyers, N distinct seats" would quietly become four buyers per
seat, which is precisely the bug run 2 exists to detect. The stride split _is_ that mapping, so the
recovery is exact by construction rather than by arithmetic that has to add up;
`schedule-split.ts` wrote the formula down when it chose the stride, for this milestone.
**Consequences:** a request object is allocated per dispatch rather than per scenario — the honest
cost, since a client sending a different body each time really does build it each time. The
body-encoding memo in `http-transport.ts` is keyed on the request object, so it stops hitting for
varying requests; it stays correct (encode once per distinct request) and simply stops helping.
`request(state)` continues to work — the second parameter is optional to the user.

## 2026-08-02 — [D2-03] M2: counters and checks live per scenario, and D1-06's example is corrected

**Context:** D1-06's worked example promised `s.counters.reserved201` at the top level. D1-05, added
later, established that a run holds several concurrent scenarios, and `metrics/` namespaces
everything per scenario.
**Decision:** thresholds read `s.scenarios[i].counters.reserved201` and
`s.scenarios[i].checks.doubleSell.failed`. There is no merged top-level view, not even as a
convenience.
**Rationale:** the two promises cannot both hold. Merging across scenarios means a `reserved201` in
the write scenario and one in the read scenario silently add together — the class of quiet wrongness
this repo has refused at every turn — and a convenience view is exactly the form everyone would
reach for. Correcting the older example is cheaper than bending the storage to fit it, and
per-scenario is the shape that needs no translation layer.
**Consequences:** thresholds are wordier. `docs/design/m1.md`'s D1-06 example is updated rather than
left to mislead.

## 2026-08-02 — [D2-04] M2: a check that throws is a broken check, not a failed one

**Context:** user code now runs per response, on the hot path, inside a worker.
**Decision:** a check returning `false` is a **failure** — counted against its name, reported as a
row, readable by thresholds. A check or `onResponse` that **throws** is a _broken_ check: counted
separately, the run continues, and the run fails at the end with the check named.
**Rationale:** the same split M1's D1-06 made for threshold predicates, for the same reason. A bug
in an assertion must not be reported as the target violating an invariant — that sends someone
hunting a race condition that was never there — and must not abort a twenty-minute run either. A
check that throws on every response would otherwise fill a run with noise; counting is what makes it
visible without drowning the report.
**Consequences:** the summary carries a broken-check tally alongside pass/fail, and the report and
dashboard distinguish the three states.

## 2026-08-02 — [D2-05] M2: checks, counters and trends are reported per scenario, and failures show live

**Decision.** `ScenarioRunSummary` carries `counters`, `checks` and `trends`; the markdown report
prints a table for each; the live dashboard shows failing and broken checks while the run is still
going, next to the drops it already showed.

**Why.** A tool that can record a claim and cannot print it has not made the claim. The dashboard
half is the same argument as drops: waiting for the summary to reveal that `noDoubleSell` has been
failing for eight minutes wastes eight minutes, and the run was already telling the truth — just
not to anyone. The report half is what open-ticket asked for by name: a checks table it can paste.

**Rejected.** A merged top-level view of counters across scenarios, for the reason in D2-03: a
`reserved201` in the write scenario and one in the read scenario would add together into a number
no reader could decompose. Scenario is the only aggregation level that cannot silently mean two
things.

**Rejected.** Printing the checks table only when something failed. "Every check passed" and "no
checks were declared" would then render identically, and the difference between them is the
difference between a proven run and an unasserted one.

## 2026-08-02 — Requests that could not be built are their own count, in the accounting identity

**Decision.** `request()` throwing is counted as `requestErrorCount`, a named field on the scenario
summary, and the run's identity becomes `dispatched + dropped + requestErrors === scheduled`. It is
kept apart from `errorCount` (transport failures) and from `droppedCount` (the in-flight cap).

**Why.** All three are "a scheduled request that produced no response", and collapsing them loses
the only thing a reader can act on. A transport error says look at the target; a drop says raise
`maxInFlight`; a request error says fix the config — the target was never asked. The first version
counted these into a metric nothing published, which quietly broke the identity the README claims
and left a halved achieved rate with no cause anywhere on the page.

**Rejected.** Failing the whole run on the first `request()` throw. A twenty-minute run that dies
at minute three publishes nothing, and the requests that did go out were real measurements. The
count is reported, the advice names `request()`, and thresholds can fail on it explicitly.

## 2026-08-02 — The reserved metric namespace is refused at both edges, differently

**Decision.** Names beginning `stampede.` are refused. From the config — check names, scenario
names — that is a startup error with the offending name quoted. From response data at runtime —
`record.count(...)` inside `onResponse` — it is refused, counted as a broken observation, and the
run continues.

**Why.** The engine's counters and the user's share one map, so `record.count("stampede.dropped",
100)` would otherwise make a run report four hundred dropped requests that never happened, in a
tool whose entire pitch is that its numbers are honest. The split follows `metrics/validate.ts`'s
existing rule: config-derived input can throw, because nothing is running yet; data-derived input
cannot, because a run is in flight and killing it costs more than refusing one counter.

**Also.** A check name is budgeted against the counter derived from it
(`stampede.brokenCheck.<name>`), because the metrics registry _silently refuses_ an over-long name
rather than throwing — so a check named right up to the limit would lose its attribution at exactly
the moment someone needed to know which claim broke.

## 2026-08-02 — An `async` check is refused before the run starts

**Decision.** `config/load.ts` rejects a check or `onResponse` whose constructor is
`AsyncFunction`, naming it and saying to drop the keyword.

**Why.** TypeScript assigns `async (r) => r.status === 201` to a `(r) => boolean` parameter without
a word of complaint. The return value is a promise: truthy, never `false`, so **every check would
have passed forever** — the worst failure this tool has, a green run that verified nothing. The
engine also neutralises a returned thenable at runtime and counts the observation broken, because
the engine is exported for programmatic use where nothing goes through the loader; but the config
path is where the mistake will actually be made, and there it is a message rather than a tally.

## 2026-08-02 — The engine's counters are reserved by registration, not by prefix

**Decision.** `runDispatch` claims a counter slot for every engine metric, and one per declared
check, before a single request goes out. `Counters.reserve()` sets the name to zero; the
cardinality rule only ever asks whether a name is already known.

**Why.** The `stampede.` prefix stops a user counter _overwriting_ an engine one. It does nothing
about _starvation_. Names are admitted while the map is under `MAX_DISTINCT_TALLIES`, and every
engine counter is created lazily on its first increment — so an `onResponse` doing
`record.count(\`seat-${id}\`)`, which is contract run 2's own shape, fills the map and everything
the engine has not yet counted is refused from that point on.

The counters that starve are exactly the ones that matter. `dropped` and `abandoned` are first
incremented when the target falls over, which is _after_ a run's worth of user names exist: a run
that dropped 350 requests reported zero drops, `dispatched + dropped + notBuilt === scheduled`
stopped holding, and a check that started breaking late published `PASS parsesBody 600/0/0` with a
green exit. `observe.ts` carried a comment asserting the total could not be lost while the
attribution could; both were refused by the same rule.

**Rejected.** Exempting engine names from the cap. The cap would then describe something other than
the size of the map, which is worse than a nine-name tax on a 512-name budget.

**Rejected.** Reserving only the counters that can actually starve. `dispatched` and `responses`
cannot — they fire before any user name exists — but "which engine counter happens to fire first"
changes the moment the dispatch loop is reordered, and encoding it would make a correctness
property depend on statement order.

## 2026-08-02 — Checks are capped per scenario, because each one costs a counter slot

**Decision.** `MAX_CHECKS_PER_SCENARIO = 64`, enforced at config load.

**Why.** Each declared check reserves a counter for its broken tally out of the same budget the
user's own counters draw on. Unbounded, 400 checks would silently leave a config 103 counter slots
and then fail its run with a message about counters-per-seat — a diagnosis pointing at the wrong
thing. 64 is generous for named claims about one scenario and leaves the budget recognisably
intact.

## 2026-08-02 — Refused recordings fail the run, and exit 2 outranks exit 1

**Decision.** `refusedRecordings` is published per scenario and fails the run on exit 2. When more
than one thing went wrong, every reason is reported, and the run-failed code wins over the
threshold-violated code.

**Why.** Cardinality caps refuse recordings rather than throwing, which is right — a run must not
die at minute nineteen because a config asked for one name too many. But the refused names are
missing _entirely_, not undercounted, so a threshold reading one gets a confident `0` and reports a
violation the target never caused. `metrics/validate.ts` already stated the rule this enforces: a
refusal nobody counts is a silent hole in the numbers.

Exit 2 outranking exit 1 follows from what the codes mean. Exit 1 says "the target broke an
invariant" — a claim about the system under test. A run whose own assertions are unsound cannot
make that claim at all, so "the run failed" is the honest verdict even when a threshold also fell.
The _reasons_ are not ranked, only the code: all of them print.

**Rejected.** Reporting only the first reason. A config with a typo'd check and a seat that sold
twice printed only the typo, losing the double sell — the thing the tool exists to find. One
failure hiding behind another is how a second bug survives a fix for the first.

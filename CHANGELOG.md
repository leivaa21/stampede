# Changelog

Notable changes per release. Dates are the release date; the reasoning behind each decision lives
in [`docs/decisions.md`](docs/decisions.md).

## 0.2.0 — unreleased

The release that makes stampede an **assertion tool** rather than a benchmarker: it proves
invariants, not just percentiles.

### Added

- **Checks** — named predicates per scenario, counted three ways: passed, failed, and _broken_. A
  check that throws is a bug in the claim, not a violation by the target, and reporting it as the
  latter would accuse a system of breaking an invariant over a typo (D2-04).
- **`onResponse`** — custom counters and trends, merged exactly across every worker thread.
- **Declared key spaces** — `counters: { byStatus: { keys: [...] } }` with `record.countKeyed()`,
  so a per-outcome breakdown is possible without a cardinality bomb (D25-01).
- **`request(state, ordinal)` carries the run's ordinal**, not the shard's, so "N buyers, N
  distinct seats" survives four threads (D2-02).
- **Purity is enforced.** The setup state is guarded in each worker, so a builder that consumes
  shared state — `state.seats.pop()` — fails with the contract named and the field named, instead
  of publishing numbers that are wrong in a way no threshold would catch (D25-02).
- **A nightly reality gate.** `pnpm gate:two` now also runs on a schedule and opens an issue when a
  claim stops holding, so published numbers cannot rot unnoticed. Never a required check (D25-03).
- **`pnpm check:package`** — packs, installs and runs the published tarball.

### Fixed

- **The binary would not have run once installed.** `dist/cli.js` was built with no shebang, so
  the shell parsed the JavaScript as shell script. Present since M1 and invisible to every gate,
  because `pnpm dev` runs the source and nothing installed the tarball. Caught while preparing this
  release — the first time anyone ran what the repo publishes — and `pnpm check:package` now packs,
  installs and runs it on every PR.
- **Engine counters could be starved.** A user counter per seat filled the 512-name budget, and
  every engine counter that had not yet fired was refused — a run that dropped 350 requests
  reported zero drops. Counters are now reserved by registration, and refused recordings are a
  published number that fails the run.
- **A run that lost most of its schedule reported PASS.** A `request()` failing on 9 of 10 ordinals
  published a p99 from the single remaining sample and exited 0. It now fails on exit 2.
- **Every writer of free text is control-character stripped**, with no exception. A target can
  reach some of them, and a load tester whose report a hostile target can edit is not evidence.

### Changed

- **Exit 2 outranks exit 1.** A run whose claims are broken cannot be trusted to have judged the
  target at all, so "the run failed" is the honest verdict even when a threshold also fell. (The
  `0`/`1`/`2` contract itself is from 0.1.0.)
- The accounting identity is now four terms:
  `dispatched + dropped + requestErrors + impureRequests === scheduled`.

## 0.1.0 — never published

The instrument, built as M1: open-loop dispatch timed from the _scheduled_ instant (so coordinated
omission is structurally impossible), HDR-style histograms whose merge is exact and
order-independent, a worker pool splitting the schedule by stride, TypeScript configs loaded by
Node's own type-stripping, a live terminal dashboard, and a markdown report.

The version existed in the repo but was never pushed to npm, which is just as well — its binary
would not have run once installed. **0.2.0 is the first release.**

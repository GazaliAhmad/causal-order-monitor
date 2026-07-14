# Roadmap

This file records the `v0.2.3` release baseline for `@causal-order/monitor` while preserving the earlier runtime and operational decisions.

`@causal-order/monitor` is a deployable recovery envelope around `@causal-order/transport`, `@causal-order/dedupe`, and `causal-order`. It is designed to preserve short-horizon ingress, route safely through degraded conditions, and make replay behavior inspectable for operators and harness tooling.

## Principles

- Prefer conservative recovery behavior over clever but hard-to-trust automation.
- Keep buffering bounded and explicit rather than letting temporary storage quietly become long-term persistence.
- Treat replay safety as more important than replay speed.
- Keep one recovery truth path whenever possible.
- Treat transport outages as a first-class operational signal even when `/monitor` cannot buffer events it never receives.
- Make operator evidence part of the product, not a later cleanup task.
- Expose timing and lateness as neutral evidence; leave every business horizon, threshold, and disposition decision to application owners.
- Align `/monitor` validation with `@causal-order/testing` instead of inventing a separate testing world.

## Current Release

- Status: `v0.2.3` is the current published npm release.
- The `v0.2.3` package hardens crash, storage-failure, concurrency, serialization, and shutdown boundaries while keeping the v0.2.2 public surface and SQLite schema version 2 unchanged.
- `v0.2.3` corrects literal BigInt-sentinel payload handling, makes close idempotent, defines post-close behavior, and gates the failure-boundary contracts in default CI.
- The policy-neutral `MonitorEventTimingEvidence` handoff remains available at the root and `/types` entrypoints without monitor prescribing business policy.
- The published monitor operates with bounded SQLite buffering, health-aware routing, replay coordination, operator-facing inspection output, JSON config loading, built-in `node:sqlite`, export-contract validation, and fail-fast replay ownership guidance.

## Package Intent

`@causal-order/monitor` sits in the stack as:

```text
node ingress
  -> @causal-order/transport
  -> @causal-order/monitor
  -> @causal-order/dedupe
  -> causal-order
```

Its role is to:

- observe component health, including transport lifecycle
- capture short-horizon ingress in SQLite
- switch routing mode when `/dedupe` or `causal-order` fails
- record transport blackout and reconnect-burst periods
- coordinate replay when the stack recovers
- expose enough runtime evidence for operators and harness tooling to explain what happened
- expose policy-neutral event timing evidence for company-owned application logic

### SQLite ownership boundary

`@causal-order/monitor` owns its bounded event reservoir and its SQLite implementation, `SQLiteReservoir`. That store is part of monitor's ingress-buffering and replay contract; it is not delegated to or abstracted by `@causal-order/persistence`.

`@causal-order/persistence` may independently provide SQLite as one adapter for persistence-owned concerns such as WALs, checkpoints, and component state. The two packages may therefore both use SQLite, but they own separate data, schemas, lifecycles, and APIs. A persistence SQLite adapter does not absorb the monitor reservoir, and no future consolidation should be inferred without a separate explicit architecture decision.

The planned cross-package recovery contract is not implemented by the current monitor and is not part of v0.2.3. Until that integration milestone, `SQLiteReservoir` remains the standalone monitor's sole recovery authority. A future persistence integration must first settle the shared recovery identity, add any required monitor schema support, and implement deterministic cross-store reconciliation before it can ship.

It is not meant to be:

- a permanent event database
- a generic dashboard product
- a replacement for `causal-order`
- a replacement for `@causal-order/dedupe`
- a lateness policy engine or source of business-operation thresholds and presets
- a business dead-letter, quarantine, compensation, or discard decision-maker

## Shipped Scope

The `v0.1.1` release includes:

- exported runtime contracts through `createMonitorRuntime()`, `MonitorRuntime`, and the package subpath entrypoints
- a SQLite-backed reservoir with rolling `4h` retention and a hard `6h` dual-outage ceiling
- health tracking for `transport`, `dedupe`, and `causal-order`
- routing across `normal`, `dedupe_bypass_throttled`, `order_buffer_only`, `full_outage_buffer`, and `replay_through_dedupe`
- replay coordination with backlog drain gating, retry backoff, and recovery confirmation heartbeats
- operator-facing inspection output for operational posture, replay readiness, backlog progress, retry delay, and live-flow gating
- direct inspected snapshot access from both `MonitorRuntime` and `TransportMonitorAdapter`
- transport-facing adapter integration through `TransportMonitorAdapter`
- monitor-aware harness integration and artifacts for `@causal-order/testing`
- an on-disk default reservoir path at `./.causal-order-monitor/monitor.sqlite`
- automatic creation of the SQLite parent directory on first boot
- built-in `node:sqlite` instead of `better-sqlite3`
- JSON config loading through `monitor.config.json`
- `CAUSAL_ORDER_MONITOR_CONFIG` support and explicit config precedence
- convenience runtime and adapter boot helpers for file-backed or environment-backed startup
- monotonic-backed wall-clock timing inside the default runtime
- batched prune enforcement through `reservoir.pruneBatchSize`
- tracked release-facing validation records for overnight 8-node dual-outage and order-outage wall-clock runs

## Fixed Release Decisions

These behaviors are fixed in the `v0.1.1` release:

- the healthy buffer is always active and rolling for `4h`
- the dual-outage retention ceiling is a hard `6h` maximum
- replay always returns through restored `/dedupe`
- replay failure backs off before retry and keeps live flow gated while backlog recovery is unsettled
- retry-waiting backlog is visible directly in runtime stats and snapshot inspection
- inspection describes operator posture directly instead of only exposing raw replay fields
- downstream consumers can obtain the inspected operator summary directly from runtime surfaces

## Validation Evidence

The `v0.1.1` release is backed by:

- repo-local type validation through `npm run check`
- inspection regression coverage through `npm run test:inspect-snapshot`
- healthy-flow replay guard coverage through `npm run test:no-healthy-replay`
- replay failure and retry safety coverage through `npm run test:replay-safety`
- monitor harness validation through `@causal-order/testing@0.2.6`
- reviewed harness artifacts showing healthy flow, `order_buffer_only`, replay-through-recovery, and drained completion
- verified on-disk SQLite default behavior with bounded retained state available for inspection
- config/env resolution coverage through `npm run test:config-env-resolution`
- runtime bootstrap coverage through `npm run test:runtime-bootstrap`
- prune batching coverage through `npm run test:prune-batching`
- direct retention/admission coverage through `npm run test:retention-admission-contract`
- deterministic 8-node threshold validation through `npm run test:http-thresholds-8nodes`
- operational suite coverage through `npm run test:monitor-operational-smoke` and `npm run test:monitor-operational-full`
- tracked overnight 8-node wall-clock validation in `validation/monitor-dual-outage-8h-wallclock-8nodes.md` and `validation/monitor-order-outage-8h-wallclock-8nodes.md`

## Acceptance Summary

`v0.1.1` is the release where:

1. the package exports a real runtime API
2. SQLite buffering works with rolling `4h` behavior
3. dual outage enforces a hard `6h` maximum
4. transport health transitions and blackout periods are recorded clearly
5. `/dedupe` outage triggers throttled direct-to-order behavior
6. `causal-order` outage triggers backlog accumulation and later replay
7. replay routes through restored `/dedupe`
8. live flow stays closed until replay and recovery confirmation are complete
9. `/testing` validates the major healthy and degraded paths
10. monitor-aware artifacts and summaries exist for incident review
11. replay failure does not churn into uncontrolled retry loops
12. retry timing and failure evidence are visible in runtime state
13. retry-waiting backlog is visible through reservoir stats and inspection helpers
14. runtime-facing consumers can retrieve the same inspected operator summary directly from `MonitorRuntime` or `TransportMonitorAdapter`
15. deployers can configure the package through `monitor.config.json` or `CAUSAL_ORDER_MONITOR_CONFIG`
16. the package uses built-in `node:sqlite` on Node `>=22.13.0`
17. retention cleanup runs in bounded SQLite batches instead of one oversized sweep
18. the `202` / `503` ingress contract is validated directly
19. the overnight 8-node dual-outage wall-clock run is preserved as tracked release evidence

## Outcome

The package is successful when teams can say:

```text
we know what failed,
we know what was buffered,
we know how recovery happened,
and we can prove replay followed the same safety path every time
```

instead of saying:

```text
the stream went weird for a while,
then it came back,
and we hope nothing important got lost or replayed incorrectly
```

## `v0.1.1` Release Additions

The `v0.1.1` release adds:

- first-class JSON config support so deployers can provide monitor settings from a file instead of only constructing config in code
- optional environment-based config path support for deployment-friendly bootstrapping
- safe merge behavior from JSON config onto package defaults
- convenience runtime and adapter creators for file-backed or environment-backed startup
- operational guidance for deep-outage SQLite write pressure and startup-path suitability
- deterministic 8-node validation for the `4h` rolling window, `6h` hard ceiling, and `202` / `503` ingress contract
- prune hardening so retention-ceiling cleanup happens in manageable batched passes instead of one large lock-heavy sweep
- direct retention/admission contract validation proving `202`, `503`, no `429`, prune-driven cutoff enforcement, and dead-letter evidence
- operational harness suite runners and aggregate validation summaries for repeatable 8-node smoke and fuller production-shaped runs
- tracked overnight 8-node dual-outage wall-clock validation records in `validation/`

Retention semantics to preserve and document:

- the monitor does not start hard-rejecting ingress immediately when the SQLite reservoir reaches the `fullOutageMaxWindowMs` ceiling
- it keeps accepting and buffering ingress, while returning routing decisions such as `buffer_only` or `pause` as advisory backpressure signals
- it stops live forwarding when the routing state requires it
- it relies on reservoir pruning to age out old unacknowledged rows by marking them `dead_letter` once they pass the hard cutoff
- this behavior is therefore closer to “drop older buffered rows once they age past the ceiling” than “throw immediate rejection states to force upstream throttling”
- the caveat is that this is not rolling eviction on every ingest; the cutoff is enforced when pruning runs

Ingress HTTP semantics to preserve and document:

- `accept` -> `202 Accepted`
- `buffer_only` -> `202 Accepted`
- `pause` -> `503 Service Unavailable`
- if the event was accepted into the monitor, even if it was only buffered in SQLite, the ingress contract should return `202`
- if the monitor is refusing admission because it is in a protective stop state, the ingress contract should return `503`
- this mapping should not use `429 Too Many Requests` for normal monitor buffering or protective-stop semantics

## `v0.1.2` API Tightening

`v0.1.2` made future `/monitor` API tightening safer.

The purpose of `v0.1.2` was not to remove or broadly deprecate public APIs immediately.

The purpose was to make later cleanup safe by first aligning the published surface, migration paths, and validation story.

Primary goals were:

- keep the stable, high-value integration path centered on `MonitorRuntime`, `TransportMonitorAdapter`, config helpers, snapshots, and inspection
- identify which current root exports already have published subpath migration paths and which do not
- clarify the difference between low-level runtime replay control and higher-level adapter replay orchestration
- add export-contract safety so future cleanup does not break existing users abruptly
- document a smaller preferred integration story without treating documentation cleanup alone as safe deprecation proof

Shipped scope:

- inventory the current published root exports and subpath exports as an explicit compatibility contract
- add validation that proves root exports and published subpath imports resolve as intended
- document `MonitorRuntime` replay controls as low-level/manual orchestration APIs
- document `TransportMonitorAdapter` replay controls as the preferred high-level integration path
- simplify the README so it emphasizes a smaller core API and treats advanced helpers as secondary
- narrow bootstrap guidance so the file/env creator helpers are the primary documented entrypoints and the lower-level config resolution helpers are described as advanced composition tools
- treat `HealthTracker`, `DeliveryRouter`, `ReplayCoordinator`, `ThrottleController`, and `SQLiteReservoir` as safer later deprecation candidates because published subpath homes already exist
- do not begin deprecating root-only exports until published migration paths exist for them
- add a published migration path for harness metadata before considering any future move away from the root entrypoint
- decide on a published home for `createDefaultMonitorNow` before considering any future root-level deprecation
- leave metadata-only root exports such as `monitorPackageVersion` and `monitorImplementationStatus` in compatibility status until a safe migration path or later breaking strategy is explicit

Delivered themes:

- a new user can identify the main monitor integration path without scanning internal building blocks
- the package has an explicit export-compatibility story instead of relying on assumptions about which APIs are safe to move
- advanced and low-level APIs are still available where needed, but are clearly labeled as such
- future deprecations can point to real published migration targets instead of only documentation guidance
- future internal refactors carry less semver risk because export resolution and compatibility are validated directly

## Phase 1 Complete: `v0.1.3` First-wave Low-risk Deprecations

`v0.1.3` completes the safest first wave of API tightening without breaking current consumers.

The purpose of `v0.1.3` is not removal.

The published release established the warning phase only for root exports that already have a published migration path.

Delivered goals:

- start with a narrow first-wave deprecation list that is easy to explain and low-risk to reverse if needed
- preserve root import compatibility while encouraging migration to official subpaths
- keep the main package story centered on `MonitorRuntime`, `TransportMonitorAdapter`, config helpers, snapshots, and inspection
- add validation that proves deprecated root imports and their replacement subpaths coexist safely during the compatibility window

Shipped scope:

- add root `@deprecated` markers only for low-risk advanced coordinator-style exports that already have published subpath homes
- begin with:
  - `HealthTracker` via `@causal-order/monitor/health`
  - `ReplayCoordinator` and `ReplayBatch` via `@causal-order/monitor/replay`
  - `DeliveryRouter` via `@causal-order/monitor/routing`
  - `ThrottleController` via `@causal-order/monitor/throttle`
- keep `SQLiteReservoir` and `ReservoirReplayEntry` public and non-deprecated for now because they remain more plausibly useful directly for tooling/tests
- keep `monitorPackageVersion` and `monitorImplementationStatus` out of the first deprecation wave because they still do not have a real published destination
- keep harness metadata exports and `createDefaultMonitorNow` compatible and documented as secondary/specialist surfaces instead of widening the first warning wave unnecessarily
- add README migration examples showing root import to subpath import replacements for the first-wave exports
- extend export-contract validation so deprecated root imports and replacement subpaths are both proven to resolve

Acceptance results:

- the first deprecation wave is narrow, non-breaking, and based on real published migration targets
- users can see the preferred subpath replacement immediately without losing working root imports
- runtime behavior remains stable while API posture gets stricter
- future breaking cleanup, if any, can start from a warning phase that was validated directly instead of inferred from documentation alone

## Phase 2: Persistence Lifecycle and Upgrade Safety (`v0.2.0`–`v0.2.2`)

Turn the monitor's SQLite format from an implementation detail into a supported upgrade contract.

In this phase, "persistence lifecycle" means the monitor-owned `SQLiteReservoir` lifecycle. It does not refer to integration with the planned `@causal-order/persistence` package.

`v0.2.0` delivered the schema compatibility foundation:

- schema version 1 is recorded and exposed independently from the package version
- compatible unversioned databases migrate through an ordered transaction
- newer, incomplete, unrelated, and failed-migration schemas fail without partial mutation
- fixture-based validation preserves legacy rows and proves idempotent reopen
- WAL journaling with full synchronization and a lightweight routing-pressure path remove the main 10,000-row ingress bottlenecks without weakening snapshot detail

`v0.2.1` delivered complete restart-state recovery:

- pending backlog restores a queued replay posture and keeps live flow gated
- interrupted replay claims return immediately to pending because process-local ownership cannot survive restart
- retry-waiting deadlines and attempt evidence survive restart
- delivered and dead-letter rows remain terminal
- upgrade plus restart preserves accepted-row ordering and schema state
- rolled-back migrations can be corrected and retried against the same SQLite file

`v0.2.2` completes the remaining `v0.2.x` persistence-lifecycle work:

- schema version 2 records terminal transition time through a transactional version 1 migration
- delivered and dead-letter evidence have independent, explicit retention policies
- prune work is bounded per call and exposes deletion results
- WAL automatic and explicit checkpoint behavior is configurable and observable
- stopped backup, restore, and relocation preserve schema version and accepted rows
- persistence operations and rollback limitations are documented for operators
- `MonitorEventTimingEvidence` provides a type-only, policy-neutral application handoff on both public declaration surfaces
- operational SQLite `dead_letter` state remains distinct from business lateness; no `/lateness` or `/dead-letter` package is introduced

- record and expose a reservoir schema version
- replace ad-hoc column additions with deterministic, transactional migrations
- define behavior for older, newer, incomplete, and incompatible database schemas
- prove restart recovery for `pending`, `replaying`, `delivered`, retry-waiting, and `dead_letter` rows
- define bounded retention for delivered and dead-letter evidence, WAL checkpoint behavior, and long-running database growth
- document backup, restore, relocation, migration failure recovery, and local-filesystem requirements

Exit criteria:

- every supported schema upgrade is exercised against a real pre-upgrade database fixture
- interrupted migration or startup cannot silently discard or strand accepted events
- operators can identify the active schema version and follow a documented recovery procedure

## Phase 3: Crash, Storage, and Concurrency Hardening (Target: `v0.2.3`)

Prove deterministic behavior at the failure boundaries most likely to damage recovery confidence.

Status: complete in `v0.2.3`.

This phase hardens the standalone monitor. It does not introduce `@causal-order/persistence` integration, a shared `recoveryEventId`, cross-store reconciliation, persistence-candidate admission, or a `StateHydrator` handoff. Those changes begin with the first persistence-integration milestone and must not be introduced incidentally during v0.2.3 hardening.

`v0.2.3` is patch-scoped: it may add tests, documentation, and backward-compatible corrections, but it does not add public exports, result shapes, configuration fields, schema changes, or snapshot fields. If hardening proves that a new public boundary contract is required, that contract belongs in `v0.3.0` rather than being forced into this patch.

- exercise process termination and restart during append, replay claim, acknowledgement, retry, reclaim, and prune operations
- validate busy/locked databases, disk-full behavior, read-only paths, WAL failures, corrupt files, and actionable startup errors
- stress concurrent ingress, health updates, replay, inspection, pruning, and shutdown
- specify payload serialization failures, size expectations, unsupported values, and sensitive-data responsibilities
- make `close()` behavior idempotent and define calls made after shutdown
- preserve the policy-neutral timing-evidence export without adding business lateness configuration or routing

Exit criteria:

- accepted rows retain a documented terminal outcome across every tested crash point
- replay ownership and ordering invariants hold under concurrent pressure
- storage failures fail deterministically through the existing public contracts rather than producing ambiguous partial success
- crash and storage hardening do not turn monitor timing evidence into company-specific business policy

Delivered in `v0.2.3`:

- 22 deterministic before/after process-termination boundaries preserve exact row state, schema version 2, WAL integrity, and restart replay eligibility
- busy/locked, read-only, full-storage, WAL-sidecar, corruption, and incompatible-schema failures reject without ambiguous accepted rows
- deterministic async interleavings and a 300-event stress/reopen run preserve replay ownership, monitor-ingest ordering, gating, and lifecycle counts
- payload boundaries document JSON behavior and representative sizes; literal BigInt-sentinel-shaped application objects now round-trip while legacy BigInt rows remain readable
- close is idempotent, post-close mutable/database work rejects consistently, and in-flight ingress/replay rows remain recoverable after restart
- exact compatibility auditing protects package exports, class methods, config/result/snapshot shapes, and the unchanged schema layout

## Phase 4: Versioned Operator and Boundary Contracts (Target: `v0.3.0`)

Stabilize the inspection model as a machine-consumable operational API.

- version the inspected snapshot schema and keep it JSON-safe
- introduce any new public boundary-result or typed-error taxonomy justified by `v0.2.3` characterization
- expose deterministic overall status, affected components, backlog age, replay progress, storage pressure, and recommended action
- distinguish contained buffering (`202`) from protective refusal (`503`) without requiring callers to infer posture from raw counters
- guarantee bounded snapshot query cost with indexed aggregation and regression benchmarks
- add operator runbooks for outage, retry wait, terminal replay failure, storage pressure, and recovery

Exit criteria:

- all operational states map to stable status and action semantics
- snapshot generation uses a bounded number of indexed database reads
- compatibility tests protect the versioned snapshot contract
- compatibility tests protect new public boundary and error contracts

## Phase 5: Stack Integration and Artifact Contracts (Target: `v0.4.0`)

Validate the monitor as the recovery layer for the real causal-order package stack, not only as a repository-local library.

- install the packed monitor tarball into clean ESM TypeScript consumers
- validate every documented root and subpath import from the packed artifact
- run compatibility suites against supported `@causal-order/transport`, `@causal-order/dedupe`, `causal-order`, and `@causal-order/testing` versions
- preserve replay-through-dedupe, replay ownership, and `202`/`503` contracts at the transport boundary
- publish a complete reference integration covering healthy delivery, degradation, outage buffering, restart, recovery, and replay

Exit criteria:

- CI tests the same npm artifact consumers install
- the supported peer-version matrix is explicit and continuously exercised
- the reference integration completes the full failure and recovery lifecycle without repository source imports

## Phase 6: Performance and Soak Qualification (Target: `v0.5.0`)

- establish repeatable ingress, replay, prune, startup, and inspection benchmarks
- run long-duration healthy-flow, extended-outage, reconnect-burst, and repeated-recovery soak contracts
- define bounded expectations for memory, file descriptors, database/WAL growth, retry activity, and shutdown duration
- test representative 8-node workloads and publish limits as measured operating envelopes, not universal throughput claims
- retain reproducible validation summaries and environment metadata with release evidence

Exit criteria:

- no unexplained resource growth remains across the supported soak scenarios
- performance regressions are detectable from repeatable baselines
- documented sizing guidance connects ingress rate, outage duration, disk capacity, and replay rate

## Phase 7: API Convergence and Compatibility Policy (Target: `v0.6.0`)

- audit every root export, subpath, adapter result, configuration field, snapshot field, routing mode, reason code, and error type
- define semantic-versioning rules for TypeScript types, config defaults, peer dependencies, subpaths, snapshots, and the SQLite schema
- complete supported deprecation windows and remove only APIs whose migration path has been released and validated
- normalize lifecycle, error, and boundary-result semantics before freezing the surface
- require compatibility review for new public API after this phase

Exit criteria:

- no known public-surface redesign is deferred to `v1.0.0`
- all removals have tested migration guidance
- the intended `v1` root and subpath surfaces are explicit contract fixtures

## Phase 8: Platform Qualification (Target: `v0.7.0`)

- declare the supported Node.js and operating-system matrix
- run packed-artifact tests across the supported platform matrix

Exit criteria:

- supported platforms pass the same core recovery contracts

## Phase 9: Operations and Release Readiness (Target: `v0.8.0`)

- complete deployment, storage, upgrade, troubleshooting, and incident-response documentation
- verify npm provenance, package contents, licenses, peer dependency guidance, and reproducible release checks
- conduct a security and data-handling review of persisted payloads and operator evidence

Exit criteria:

- a new operator can deploy, inspect, upgrade, back up, restore, and troubleshoot the monitor from published documentation
- release automation rejects incomplete or mismatched package metadata
- persisted payload and operator-evidence responsibilities are documented and reviewed

## Phase 10: v1 Readiness Burn-in (Target: `v0.9.0`)

`v0.9.0` is a normal pre-1 release, not a SemVer pre-release identifier. If final `v1.0.0` artifacts require candidate publication, use `v1.0.0-rc.N` only for those actual candidates; no release-candidate sequence is preallocated.

- freeze avoidable feature work and treat the public API and schema as release candidates
- exercise fresh install, upgrade from every supported schema, crash recovery, prolonged outage, and downgrade-rejection paths
- run the reference stack under external-consumer conditions using only published-style package artifacts
- resolve all critical correctness, ordering, replay, migration, data-loss, and operational defects
- publish a `v1.0.0` migration and readiness checklist

Exit criteria:

- the v1 readiness release completes the full validation matrix without unresolved critical defects
- no breaking public API or persistence redesign is planned for `v1.0.0`
- release evidence is reproducible from documented commands

## Version 1.0: Stable Causal-order Recovery Contract (Target: `v1.0.0`)

Publish `v1.0.0` only when the monitor can make a durable compatibility and recovery promise to production consumers.

- Phases 1 through 10 are complete and their required suites run in CI
- the public API, subpaths, configuration, operator snapshot, routing/reason codes, and error model are stable
- the SQLite schema is versioned, supported migrations are transactional, and restart/crash recovery is proven
- replay always follows the documented dedupe path and preserves ownership, gating, retry, and ordering invariants
- supported stack versions and platforms pass packed-artifact integration, failure, upgrade, and soak validation
- production documentation and migration guidance are complete
- no unresolved critical correctness, ordering, data-loss, or recovery issue remains

# Changelog

## v0.5.0

- reorganized the README as a concise consumer entry point and moved detailed guidance into focused API, configuration, deployment, schema-compatibility, timing-evidence, and migration documents
- added dedicated migration guidance for the versioned operator snapshot and preferred functional subpath imports while preserving the existing compatibility surfaces
- clarified deployment sizing, single-owner SQLite operation, payload handling, and the distinction between storage-pressure evidence and the capacity controls delivered in v0.5.0
- added a machine-readable v0.5.0 capacity, schema-accounting, lifecycle, and compatibility contract with an executable expected-red baseline ahead of production implementation
- introduced SQLite schema version 3 with transactional per-row serialized-event byte evidence and singleton pending row/byte accounting across append, acknowledgement, restoration, bulk transition, and dead-letter paths
- added fail-closed startup validation for per-row or aggregate accounting mismatches, transactional schema-v2 migration without payload rewriting, and focused migration, rollback, restart, Unicode, and mixed-transition coverage
- added opt-in serialized-event, pending-row, and logical pending-byte limits with inclusive boundaries and atomic refusal-before-insert checks against schema-v3 accounting
- added `MonitorCapacityRefusedError` with stable limiting dimensions, reason codes, retry guidance, JSON-safe evidence, and protective HTTP `503` semantics distinct from SQLite storage failures
- documented strict JSON/programmatic capacity configuration, logical-versus-physical scope, zero-limit behavior, capacity release, and upstream retry responsibilities
- added opt-in filesystem-reserve admission with separate minimum/resume thresholds, low-space hysteresis, and explicit allow-or-refuse behavior when filesystem evidence is unavailable
- added shared versioned `capacity` facets on the reservoir, runtime, and adapter with bounded logical usage, physical storage evidence, utilization, last-refusal evidence, and process-lifetime refusal/storage-failure counters
- preserved the exact operator snapshot v1 shape while keeping preventive reserve refusal distinct from genuine SQLite full, read-only, contention, WAL, and I/O failures
- added a shared typed `lifecycle` facet on runtimes and adapters with a frozen 20-event payload-free model, selective subscriptions, and idempotent unsubscription
- added bounded FIFO `drop_oldest` dispatch with non-awaited publication, concurrent per-event listeners, isolated sync/async listener failures, observable drops/failures, and explicit bounded flush
- defined synchronous shutdown behavior that rejects new subscriptions, counts queued observations as shutdown drops, clears listener state, and preserves recovery authority exclusively in committed SQLite state
- instrumented all 20 lifecycle facts across ingress, configured refusal, storage failure, delivery phases, replay, retention, health, capacity/storage pressure, checkpointing, scheduler work, and operation durations
- separated handler completion from committed delivery acknowledgement and definite handler failure from accepted-but-indeterminate adapter completion without changing existing result or recovery authority
- added SQLite-verified lifecycle timing coverage proving accepted, acknowledged, replayed, dead-lettered, deleted, and health-transition observations do not precede their authoritative mutation
- added a correctness-gated, environment-labelled benchmark command covering healthy and saturated admission, replay drain, bounded prune, startup/restart, inspection, scheduler pacing, and lifecycle listener pressure
- retained a five-sample v0.5.0 comparative baseline with median/p95 distributions, ignored raw output, explicit workload identity, and reviewed same-environment regression bands without claiming universal throughput
- added eight-node smoke, medium, eight-hour accelerated-horizon, and ten-minute continuous Phase 6 qualification covering quota refusal, upstream retry ownership, scheduler-paced replay, exact-row retry deadlines, repeated recovery, observer pressure, restart overlap, final drain, and resource envelopes
- made the reference scheduler skip replay while dedupe or causal-order is offline, avoiding predictable unavailable-target errors while health and prune cadence continue
- stopped unchanged heartbeats and identical saturated replay snapshots from producing unbounded auxiliary history while retaining actual health transitions and replay progress
- retained environment-specific v0.5.0 soak summaries with stable resource-window analysis, bounded shutdown/reopen evidence, SQLite integrity, and deployment sizing equations without universal throughput claims
- made long wall-clock soak reporting compute scheduler-gap maxima iteratively so high sample counts cannot exceed the JavaScript argument-stack limit after qualification completes
- integrated deterministic Phase 6 capacity, lifecycle, auxiliary-growth, retained-summary, and accelerated sustained-load smoke contracts into the default CI release gate
- extended installed-artifact validation to consume new capacity/lifecycle declarations and prove quota refusal, payload-free lifecycle observation, restart-safe backlog preservation, replay through dedupe, quota release, and resumed delivery from the packed package
- published the completed Phase 6 package as `@causal-order/monitor@0.5.0` with aligned metadata, documentation, release validation, and v0.6.0 handoff records

## v0.4.0

- validated the packed monitor artifact across clean ESM TypeScript consumers and the supported causal-order stack peer matrix
- serialized concurrent adapter replay reconciliation and batch pumping onto one in-flight operation
- defined one live SQLite reservoir owner per runtime/adapter and documented stopped backup, restore, relocation, and restart procedures
- added optimistic and conservative startup-health policies
- added the optional caller-owned `MonitorScheduler` reference scheduler with retry-aware replay, bounded pruning, and deterministic shutdown
- added the packed full-stack lifecycle covering startup, healthy delivery, outage buffering, restart, replay failure/backoff, and recovery through dedupe
- integrated the Phase 5 contracts into CI while preserving v0.3 compatibility and operator semantics

## v0.3.3

- added a retained v0.3.0 public-contract fixture and expanded compatibility validation across every published runtime namespace, generated declaration literals and operation signatures, public prototypes, configuration, raw/unversioned/versioned snapshots, result shapes, and the complete schema-v2 table/column/index layout
- added explicit migration guidance from the unversioned BigInt inspection surface to the discriminated JSON-safe v1 operator snapshot while preserving both APIs throughout the v0.3.x compatibility line
- audited README and operator/persistence runbooks against public v1 fields and stable action/admission meanings, correcting the retry-wait procedure numbering without changing runtime semantics
- recorded v0.3.3 as the final planned v0.3.x compatibility-closure release; later v0.3.x versions are reserved for unscheduled backward-compatible maintenance
- preserved the complete v0.3.0 contract, v0.3.1/v0.3.2 hardening behavior, SQLite schema version 2, and all inherited recovery invariants without requiring a production-code correction

## v0.3.2

- hardened filesystem storage-pressure classification to compare exact integer byte ratios at the 5% critical and 15% elevated boundaries instead of deriving pressure from a rounded display percentage
- added deterministic coverage for exact threshold values, immediately adjacent byte values, zero/full availability, and invalid filesystem metadata
- expanded WAL lifecycle validation to cover database and WAL byte evidence across create, write, checkpoint, close, and reopen transitions
- expanded the fixed-query inspection contract from an empty reservoir through 10,000 pending rows while preserving four index-backed aggregations
- exercised versioned operator inspection while ingress, replay, pruning, and checkpointing overlap, preserving JSON safety, ordering, gating, lifecycle counts, and reopen state
- kept repository development and npm-published version markers distinct during release-candidate preparation and publication dry runs
- preserved the complete v0.3.0/v0.3.1 public contract, SQLite schema version 2, and all inherited recovery invariants

## v0.3.1

- fixed active replay backoff so the documented `recovering` and `wait_for_retry` operator posture is reachable instead of being masked by terminal-failure precedence
- fixed expired failed-replay inspection so the live-flow recovery gate remains reported as closed and accepted buffering uses `MONITOR_RECOVERY_GATE_BUFFERING` until replay resumes or backlog is reconciled
- added a table-driven operator edge-state contract covering 13 healthy, degraded, buffering, recovery, retry, failure, refusal, and storage-pressure mappings with JSON round-trip validation
- added a configurable eight-node combined wall-clock validation runner that cycles individual, paired, and triple transport/dedupe/causal-order failures, models transport-owned retry explicitly, checks replay-through-dedupe and final drain, and records resource/storage evidence
- completed and preserved the eight-hour 1x combined fault-cycle evidence: all `427737` unique events reached the simulated order sink, all held and buffered work drained, resource limits held, and a `96.2%`-used physical filesystem correctly remained `attention_required / free_local_storage` without hiding recovery or causing an indeterminate outcome
- preserved the complete v0.3.0 operator snapshot shape, stable enums and reason codes, boundary taxonomy, SQLite schema version 2, and inherited recovery behavior

## v0.3.0

- added the discriminated `causal-order-monitor/operator-snapshot` version 1 contract through runtime and adapter `getOperatorSnapshot()` methods plus the pure `inspectMonitorSnapshotV1()` projection
- made the complete versioned operator snapshot JSON-safe by representing millisecond and byte quantities as decimal strings while preserving the existing unversioned BigInt inspection surface
- exposed stable overall status, affected components, recommended action, admission posture, backlog age, replay progress, and bounded database/WAL/filesystem storage-pressure evidence
- added explicit admission semantics: accepted live and buffered work maps to `202`, while protective refusal throws `MonitorAdmissionRefusedError` before persistence and maps to `503`
- added stable boundary codes and JSON-safe classification for shutdown, SQLite contention, full storage, read-only storage, I/O failure, and persisted-but-unobserved adapter completion
- made post-close work throw `MonitorClosedError` and made asynchronous adapter completion failures after persistence throw `MonitorIndeterminateOutcomeError` with the accepted row identity for storage reconciliation
- added a four-query snapshot cost contract proving the existing reservoir aggregations remain index-backed at a representative 1,000-row backlog without payload materialization, integrity checks, or schema changes
- added exact export, prototype, snapshot-shape, admission, boundary, query-plan, shutdown, and compatibility coverage to default CI while preserving SQLite schema version 2
- added operator runbooks for outage buffering, protective refusal, retry wait, replay, terminal failure, storage pressure/failure, restart recovery, indeterminate completion, and shutdown

## v0.2.3

- added deterministic child-process crash characterization across 22 before/after append, claim, acknowledgement, retry, reclaim, prune, checkpoint, and close boundaries, preserving schema version 2, WAL recovery, row integrity, and restart replay eligibility
- added storage-failure contracts for busy/locked writes, structured checkpoint contention, read-only access, deterministic full-storage rejection, WAL-sidecar failure, and corrupt or incompatible database files
- added supported single-process concurrency contracts covering overlapping ingress, health changes, replay, inspection, pruning, checkpointing, a 300-event ordered replay stress run, and reopen-state verification
- fixed payload decoding so literal application objects resembling the internal BigInt wrapper round-trip unchanged while previously persisted BigInt wrappers remain compatible
- documented JSON transformations, rejection-before-acceptance behavior, representative 1 KiB, 64 KiB, and 1 MiB payload evidence, non-universal sizing responsibilities, and sensitive-data handling
- made reservoir, runtime, and adapter close idempotent; made post-close mutable and database-backed operations fail consistently without adding a new exported error type
- preserved accepted pending and replaying rows when shutdown overlaps asynchronous delivery, allowing normal restart recovery to reclaim and replay them in order
- added an exact compatibility audit that protects v0.2.2 package subpaths, runtime exports, public class methods, configuration fields, result and snapshot shapes, and the unchanged schema-version-2 layout
- added crash, storage-failure, concurrency, payload-boundary, shutdown-lifecycle, and exact compatibility contracts to default CI
- expanded persistence operations guidance for lock contention, exhausted/read-only storage, WAL I/O failures, corruption response, payload serialization, and shutdown lifecycle

## v0.2.2

- added the type-only `MonitorEventTimingEvidence` contract on the root and `@causal-order/monitor/types` surfaces so applications can consume event time, monitor-ingest time, observation time, signed lateness, and causal metadata without monitor defining business horizons or late-event policy
- kept late-event acceptance, flagging, quarantine, compensation, and discard decisions outside monitor; those policies and their configuration remain owned by each company's development team or consultants
- introduced SQLite schema version 2 with a transactional migration that records terminal-state transition time without discarding existing rows
- added independent `reservoir.deliveredRetentionMs` and `reservoir.deadLetterRetentionMs` policies, defaulting to 24 hours and 7 days respectively
- made each prune call bound terminal transitions and deletion work by `reservoir.pruneBatchSize`
- exposed delivered and dead-letter row counts through `SQLiteReservoir.getLifecycleStats()`
- added configurable `reservoir.walAutoCheckpointPages` behavior and explicit passive, restart, and truncate checkpoints with structured results
- made reservoir close perform a passive WAL checkpoint before closing the SQLite connection
- added terminal-retention, WAL-lifecycle, and stopped backup/restore/relocation contracts to default CI
- documented safe persistence operations, migration-failure recovery, local-filesystem requirements, rollback limits, WAL sidecars, and maintenance-only compaction
- preserved v0.2.0 schema compatibility and v0.2.1 restart, replay, ownership, ordering, and terminal-state invariants
- validated the packed package in a clean consumer with `@causal-order/transport@0.1.2`, `@causal-order/dedupe@1.1.1`, `causal-order@1.0.0`, and `@causal-order/testing@0.2.6`, resolving one deduplicated monitor v0.2.2 and passing TypeScript plus transport-to-dedupe-to-order runtime integration

## v0.2.1

- reconciled persisted SQLite replay state when constructing a fresh runtime
- made pending recovery backlog restore a queued replay posture and keep live flow gated before replay drain
- reclaimed all persisted `replaying` claims immediately on process restart because their in-memory owner cannot survive the process boundary
- restored an entirely retry-waiting backlog as failed/retry-waiting using its persisted absolute retry deadline and replay-attempt evidence
- kept delivered and dead-letter rows terminal across restart
- retained monitor-ingest-time and row-identity replay ordering after restart and schema upgrade
- kept `replay_sessions` as audit history while treating current ingress row state as the recovery authority
- preserved adapter-managed versus manual replay ownership enforcement after restart
- added deterministic restart-state coverage for pending, interrupted, retry-waiting, delivered, and dead-letter rows, including gating and inspection output
- added an upgrade-and-restart contract proving legacy accepted rows migrate, retain order and attempt counts, and reopen under the current schema
- extended migration rollback validation to prove the same SQLite file can migrate successfully after the injected failure condition is removed
- added restart-state and upgrade-restart contracts to default CI
- validated the packed package in a clean consumer with `@causal-order/testing@0.2.6`, confirming that its monitor peer resolves to the top-level `@causal-order/monitor@0.2.1` installation without an older nested copy

## v0.2.0

- established SQLite schema version 1 as an explicit persistence compatibility contract
- replaced ad-hoc legacy column upgrades with an ordered transactional migration path
- added structural detection for compatible unversioned databases created by earlier monitor releases
- added typed failures for newer-than-supported, incomplete, incompatible, and failed-migration schemas without flattening them into generic startup errors
- exposed current and latest supported schema versions through `SQLiteReservoir`, `MonitorRuntime`, and the storage subpath
- added fixture-based contracts proving new initialization, legacy row preservation, idempotent reopen, unsupported-schema rejection, and migration rollback
- enabled WAL journaling with `synchronous=FULL` to remove rollback-journal pressure without weakening per-transaction synchronization
- removed full operator-stat aggregation from the ingress decision hot path, initialized an exact pending-row counter from SQLite, and kept it synchronized across replay-state transitions
- evaluated cheap recovery-health guards before constructing detailed backlog statistics, eliminating the remaining full-table aggregation during outage ingress
- reused the prepared ingress statement instead of recompiling the same SQL for every event
- added schema compatibility and both 10,000-row threshold/retention pressure contracts to default CI

## v0.1.3

- began the first low-risk deprecation wave without removing public APIs
- marked the root `HealthTracker`, `ReplayCoordinator`, `ReplayBatch`, `DeliveryRouter`, and `ThrottleController` exports as deprecated in favor of their published subpath imports
- kept the deprecated root imports working so the warning phase remains compatibility-safe
- extended export-contract validation to prove deprecated root exports and replacement subpath exports coexist correctly during the compatibility window
- added README migration guidance showing the non-breaking root-to-subpath path for the first-wave deprecated exports
- kept `SQLiteReservoir`, `ReservoirReplayEntry`, `monitorPackageVersion`, `monitorImplementationStatus`, harness metadata exports, and `createDefaultMonitorNow` out of the first wave
- expanded the GitHub Actions CI matrix from Node.js 22 alone to Node.js 22 and 24
- refocused the README on npm consumers, consolidated repeated API/subpath guidance, and moved repository test procedures and release evidence into `VALIDATION.md`
- aligned the roadmap and package documentation with the published, non-breaking `v0.1.3` release

## v0.1.2

- treated `v0.1.2` as a safer API-tightening preparation release instead of an aggressive root-surface deprecation pass
- added explicit export-contract validation proving root-only exports, published subpaths, and packaged import/types targets resolve as expected
- added a published `@causal-order/monitor/testing` subpath so harness metadata no longer depends only on the root entrypoint
- added a published `@causal-order/monitor/config` home for `createDefaultMonitorNow` so it is no longer root-only
- added a typed replay ownership guard so adapter-managed runtimes reject direct manual replay commands with a dedicated `ReplayOwnershipError` instead of allowing mixed replay control on the same runtime instance
- added repo validation proving adapter-managed replay and manual runtime replay are treated as mutually exclusive control styles
- hardened recovery replay start so live flow stays clamped during pre-replay health confirmation instead of reopening immediately on a brief healthy transition
- kept replay retry backoff and post-replay confirmation visible through the inspected snapshot so operators can distinguish retry waiting, pre-replay confirmation, active drain, and post-replay confirmation
- added stale replay-claim recovery so rows that were claimed for replay but never acknowledged can be reclaimed safely instead of remaining stuck in `replaying`
- updated README guidance to center `TransportMonitorAdapter`, `MonitorRuntime`, file/env bootstrap helpers, and inspection helpers as the preferred integration path
- reclassified advanced, testing-oriented, and compatibility-only surfaces in the docs without removing them from the public contract
- aligned roadmap and local implementation docs around export inventory, migration-path safety, and validation-first cleanup

## v0.1.1

- replaced `better-sqlite3` with the built-in `node:sqlite` backend
- raised the package Node requirement to `>=22.13.0` so SQLite support does not depend on `--experimental-sqlite`
- made SQLite reservoir startup fail fast with a clearer path-specific deployment error when the configured database location is not suitable for local writes
- documented recommended server-local SQLite paths and warned against read-only, synced, or unvalidated network-mounted filesystems
- added `CAUSAL_ORDER_MONITOR_CONFIG` support with explicit precedence between inline config, env-selected config files, default `monitor.config.json`, and package defaults
- added repo validation proving env-driven config resolution and override precedence
- added convenience creators for booting `MonitorRuntime` and `TransportMonitorAdapter` directly from file or environment-backed config
- added repo validation proving the new bootstrap helpers preserve the existing explicit constructor path
- added a deterministic 8-node threshold validation covering the `4h` rolling window, `6h` full-outage ceiling, and the intended HTTP `202` / `503` decision mapping
- aligned README and roadmap guidance with the current HTTP ingress contract, prune-driven retention semantics, and `v0.1.1` bootstrap surface
- refactored SQLite prune enforcement into batched dead-letter and delete passes so large expired cohorts no longer rely on one oversized statement
- added `reservoir.pruneBatchSize` configuration and repo validation proving batched prune keeps the same retention outcomes
- added explicit README guidance for sizing host disk I/O throughput during sustained `4h` to `6h` `full_outage_buffer` periods
- clarified in the README that the `6h` ceiling is prune-driven and does not itself force immediate ingress rejection
- added a direct retention/admission contract test proving `202` vs `503`, no `429`, prune-driven hard cutoff, and observable `dead_letter` rows
- changed the default monitor runtime clock to a monotonic-backed wall-clock so in-process timing does not move backward when host wall-clock time shifts
- added an 8-node operational harness suite runner plus aggregate validation summaries for smoke and fuller production-shaped monitor runs
- added a Node 22 CI smoke pass for the operational harness suite
- added tracked release-facing validation documents for the overnight 8-node dual-outage wall-clock run under `validation/`

## v0.1.0

- switched the default SQLite reservoir from in-memory storage to an on-disk package path at `./.causal-order-monitor/monitor.sqlite`
- made the SQLite reservoir create its parent directory automatically so the package default works cleanly on first boot
- documented the new on-disk default and current configuration guidance in the README
- added a local harness wrapper script so `@causal-order/testing@0.2.6` can target this repo's built monitor module directly instead of an older npm-installed monitor package
- added a focused `no-healthy-replay` regression script to prove healthy flow does not incorrectly enter replay
- fixed replay gate behavior so recovery does not reopen early while required recovery heartbeats are still missing or buffered backlog still remains
- fixed recovery reconciliation so replay can be re-queued from a previously completed state when replay-eligible backlog is still present
- validated the repaired monitor flow with local harness runs showing the expected `normal`, `order_buffer_only`, and `replay_through_dedupe` phases and a drained reservoir at completion
- verified the on-disk SQLite default with harness runs that now leave behind a bounded reservoir file for inspection and sizing

## v0.0.9

- added `publish:prepare` metadata syncing so the exported package version and README release markers stay aligned with `package.json`
- moved npm dry-run scripts onto a repo-local cache path and added `prepublishOnly` validation to harden the publish flow
- expanded `ReservoirStats` so retry-waiting backlog is visible through `retryWaitingRows` and `earliestRetryAt`
- expanded `inspectMonitorSnapshot()` so replay retry timing, consecutive failure streak, and active backoff state are obvious at a glance
- verified the richer inspection surface against the existing `test:replay-safety` failure-path run
- aligned README and roadmap language with the current `v0.0.9` runtime, validation, and operator-inspection boundary
- enriched `inspectMonitorSnapshot()` with derived operator-facing state instead of only mirroring raw replay and reservoir fields
- added inspection signals for `operationalState`, live-flow gate status and reason, replay-ready rows, backlog remaining rows, replay progress percentage, retry delay, and operator-attention requirement
- added `MonitorRuntime.getInspectedSnapshot()` so downstream consumers can read the derived operator summary directly from the runtime
- added `TransportMonitorAdapter.getInspectedSnapshot()` so adapter users do not need to compose the runtime and inspection helper manually
- added repo-local `test:inspect-snapshot` coverage to verify the derived inspection summary through buffering and replay-retry states and to prove the direct runtime/adapter inspected snapshot path stays identical to `inspectMonitorSnapshot(getSnapshot())`

## v0.0.8

- hardened replay failure handling with a retry backoff so replay does not immediately thrash back into another attempt when downstream recovery is still unstable
- kept the replay gate closed while failed backlog is waiting for retry so live flow does not reopen into a mixed backlog state during replay recovery
- added replay snapshot evidence for `nextRetryAt` and `consecutiveFailureCount` so retry behavior is inspectable in runtime state and persisted replay session records
- hardened SQLite prune behavior so retry-waiting replay rows survive the rolling buffer window and only dead-letter at the hard retention cutoff
- added a repo-local `test:replay-safety` script that exercises replay failure, retry backoff, rolling-window prune safety, and hard-cutoff dead-letter behavior end to end

## v0.0.7

- fixed live ingress acknowledgement so events successfully forwarded on the live path are marked delivered in the SQLite reservoir instead of lingering as replay backlog
- fixed the early replay-entry bug that could push the monitor into `replay_through_dedupe` immediately after startup or healthy forwarding
- validated the repaired `monitor-order-outage` sequence end to end: healthy live flow, `order_buffer_only` during outage, replay only after recovery, and empty reservoir at completion
- extended downstream `@causal-order/testing` reporting so monitor-enabled runs now summarize replay posture and compare outage recovery behavior directly
- aligned the downstream `@causal-order/testing` package metadata to `0.2.5` and updated its published monitor peer range to `@causal-order/monitor@^0.0.7`

## v0.0.6

- extended `@causal-order/testing` integration so monitor is consumed as an optional first-class harness boundary instead of a side path
- added monitor-aware runtime config, artifact paths, and scenario profiles in the testing harness
- added dedicated outage choreography for monitor scenarios, including `dedupe` outage, `causal-order` outage, dual outage, and replay-through-recovery transitions
- validated that the legacy non-monitor testing smoke path still passes with monitor mode disabled
- ran a real `monitor-order-outage` scenario and used it to uncover and fix bigint serialization issues in monitor artifact and summary writing
- fixed monitor shutdown ordering during harness finalization so final replay and heartbeat artifacts are written before the monitor closes

## v0.0.5

- added `TransportMonitorAdapter` as the first transport-facing integration seam
- connected runtime routing decisions to downstream dedupe, direct-order, and buffer-only handlers
- added replay pumping and recovery reconciliation through the adapter surface
- added exported monitor harness metadata for `@causal-order/testing`
- defined the first monitor harness scenario catalog and expected artifacts for ecosystem validation
- updated README and roadmap status to reflect active implementation rather than scaffold-only status

## v0.0.4

- made replay coordination operational instead of snapshot-only
- added replay lifecycle control for queue, start, batch claim, acknowledge, fail, and abort
- enforced replay gating so live flow stays coordinated during backlog drain
- added post-replay downstream health confirmation before reopening live flow
- added SQLite replay row lifecycle helpers for pending, replaying, delivered, and dead-letter states
- fixed bigint-safe SQLite payload serialization for stored and replayed events

## v0.0.3

- implemented the SQLite-backed reservoir with bounded retention behavior
- added monitor schema bootstrap for ingress events, health logs, outage windows, and replay sessions
- implemented component health tracking for `transport`, `dedupe`, and `causal-order`
- implemented routing and throttle decision logic for:
  - `normal`
  - `dedupe_bypass_throttled`
  - `order_buffer_only`
  - `full_outage_buffer`
  - `replay_through_dedupe`
- added runtime ingestion and reservoir statistics APIs

## v0.0.2

- added the first real public runtime contract surface for `@causal-order/monitor`
- introduced monitor config, event, routing, throttle, health, and snapshot types
- added `createMonitorRuntime()`, `MonitorRuntime`, and `inspectMonitorSnapshot()`
- upgraded package metadata for npm publication, including peer dependencies and build outputs
- added repo-level ignore rules and publication-oriented package hygiene

## v0.0.1

- scaffolded the initial npm package metadata for `@causal-order/monitor`
- established a minimal TypeScript build surface
- documented the package as draft while the runtime API is still being designed

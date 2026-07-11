# Changelog

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

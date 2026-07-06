fix: stabilize monitor replay recovery and document testing integration# Changelog

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

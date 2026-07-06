# @causal-order/monitor

Health-aware buffering, replay, and operator monitoring layer for the `causal-order` stack.

Status: `v0.0.9` implementation baseline. `v0.1.0` is reserved for real wall-clock validation.

`@causal-order/monitor` now has a working runtime, SQLite reservoir, health tracking, routing, throttling, replay coordination, and transport-facing adapter seams. The current line also includes replay retry backoff hardening and clearer retry inspection for operators and harness tooling.

## Intended Role

`@causal-order/monitor` sits after `@causal-order/transport` and around `@causal-order/dedupe` and `causal-order` so the pipeline can degrade and recover more safely when one or more layers become unavailable.

The current design and implementation direction includes:

- health tracking for `@causal-order/transport`
- rolling SQLite-backed buffering
- health tracking for `@causal-order/dedupe` and `causal-order`
- throttled fallback when `@causal-order/dedupe` is offline
- replay-through-dedupe recovery
- transport outage visibility and reconnect-burst handling
- operator-facing metrics, traces, and incident timelines

## Version `v0.0.9`

The package has moved well beyond scaffold stage.

The current line includes:

- healthy live forwarding that clears delivered rows from replay consideration
- buffered `order_buffer_only` behavior while `causal-order` is offline
- replay gating so backlog recovery does not start too early or mix loosely with live flow
- replay retry backoff with persisted retry horizon and failure streak evidence
- retry-aware pruning so retry-waiting rows survive the rolling window and only dead-letter at the hard cutoff
- snapshot inspection that surfaces retry-waiting backlog, earliest retry horizon, replay next retry time, and consecutive replay failure count
- derived operator-facing inspection state for live-flow gating, replay-ready backlog, retry delay, and quick recovery posture reading
- direct inspected snapshot access from `MonitorRuntime` and `TransportMonitorAdapter`

## Package Shape

Current public exports include:

- `createMonitorRuntime()`
- `MonitorRuntime`
- `HealthTracker`
- `DeliveryRouter`
- `ThrottleController`
- `ReplayCoordinator`
- `SQLiteReservoir`
- `TransportMonitorAdapter`
- `inspectMonitorSnapshot()`
- monitor harness metadata for `@causal-order/testing`

The runtime-facing inspection path is now available directly through:

- `MonitorRuntime.getInspectedSnapshot()`
- `TransportMonitorAdapter.getInspectedSnapshot()`

Current snapshot and inspection surfaces include:

- `MonitorSnapshot`
- `ReplaySessionSnapshot`
- `ReservoirStats`
- `InspectedMonitorSnapshot`

## Recovery Rules

The current implementation follows these conservative rules:

- the healthy SQLite reservoir is always active and rolling for `4h`
- the dual-outage retention ceiling is a hard `6h` maximum
- replay always returns through restored `@causal-order/dedupe`
- replay failure applies a backoff window before retry
- live flow stays gated while replay recovery is failed or actively draining

## Validation

This repo currently ships a local replay safety validation path:

- `npm run build`
- `npm run test:inspect-snapshot`
- `npm run test:replay-safety`
- `npm run ci`

`test:inspect-snapshot` verifies that derived inspection output correctly reflects buffering-only and replay-retry states.

`test:replay-safety` verifies that:

- retry-waiting rows are not reclaimed too early by rolling-window pruning
- replay does not restart before the retry horizon
- rows dead-letter only at the hard retention cutoff when recovery keeps failing

The wider ecosystem validation path continues in `@causal-order/testing`, where monitor-aware scenarios and reporting exercise healthy flow, outages, replay, and recovery behavior end to end.

## Current Boundary

This is still an implementation-stage package, not a long-term stable contract line yet.

What exists now is strong enough for integration and harness validation, but no new monitor features should be added before real wall-clock testing is done.

The next milestone is `v0.1.0`, and it should be a validation milestone rather than another feature milestone.

Until then, the focus should stay on:

- stronger stack-level failure-path testing in `@causal-order/testing`
- real wall-clock retention and replay timing validation
- artifact review of backlog growth, retry waiting, drain, and prune behavior

## Local Design Notes

The deeper working notes for this repo live under `.local/`:

- `monitor-design-spec.md`
- `monitor-v0.0.1-implementation-plan.md`
- `cross-repo-change-log.md`

Those notes describe the original intent, the phased implementation plan, and the cross-repo testing work that has been done alongside this package.

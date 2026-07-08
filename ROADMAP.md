# Roadmap

This file records the shipped `v0.1.1` baseline for `@causal-order/monitor`.

`@causal-order/monitor` is a deployable recovery envelope around `@causal-order/transport`, `@causal-order/dedupe`, and `causal-order`. It is designed to preserve short-horizon ingress, route safely through degraded conditions, and make replay behavior inspectable for operators and harness tooling.

## Principles

- Prefer conservative recovery behavior over clever but hard-to-trust automation.
- Keep buffering bounded and explicit rather than letting temporary storage quietly become long-term persistence.
- Treat replay safety as more important than replay speed.
- Keep one recovery truth path whenever possible.
- Treat transport outages as a first-class operational signal even when `/monitor` cannot buffer events it never receives.
- Make operator evidence part of the product, not a later cleanup task.
- Align `/monitor` validation with `@causal-order/testing` instead of inventing a separate testing world.

## Current Release

- Status: `v0.1.1` is the current published package release.
- The `v0.1.1` package exports a real runtime surface instead of a placeholder package shell.
- The published monitor operates with bounded SQLite buffering, health-aware routing, replay coordination, operator-facing inspection output, JSON config loading, and built-in `node:sqlite`.

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

It is not meant to be:

- a permanent event database
- a generic dashboard product
- a replacement for `causal-order`
- a replacement for `@causal-order/dedupe`

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
- tracked release-facing validation records for the overnight 8-node dual-outage wall-clock run

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
- tracked overnight 8-node wall-clock validation in `validation/monitor-dual-outage-8h-wallclock-8nodes.md`

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

The next version should tighten the public `/monitor` API so the package is easier to understand, easier to maintain, and less repetitive at the top level.

Primary goals:

- keep the stable, high-value integration path centered on `MonitorRuntime`, `TransportMonitorAdapter`, config helpers, snapshots, and inspection
- reduce public exposure of metadata-only exports and internal implementation building blocks
- clarify the difference between low-level runtime replay control and higher-level adapter replay orchestration
- reduce API sprawl in the bootstrap and configuration surface without breaking existing users abruptly

Planned scope:

- de-emphasize metadata-only exports such as `monitorPackageVersion` and `monitorImplementationStatus`
- review whether `HealthTracker`, `DeliveryRouter`, `ReplayCoordinator`, and `ThrottleController` should remain root-level public exports
- keep `SQLiteReservoir` public for now, while treating it as an advanced surface rather than a mainline integration path
- document `MonitorRuntime` replay controls as low-level/manual orchestration APIs
- document `TransportMonitorAdapter` replay controls as the preferred high-level integration path
- simplify the README so it emphasizes a smaller core API and treats advanced helpers as secondary
- narrow bootstrap guidance so the file/env creator helpers are the primary documented entrypoints and the lower-level config resolution helpers are described as advanced composition tools
- review whether harness metadata exports should stay in the main public surface or move toward testing-oriented documentation only

Acceptance themes:

- a new user can identify the main monitor integration path without scanning internal building blocks
- the top-level package surface is smaller and more intentional
- advanced and low-level APIs are still available where needed, but are clearly labeled as such
- future internal refactors carry less semver burden from incidental exports

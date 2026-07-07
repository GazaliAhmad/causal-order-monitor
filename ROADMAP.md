# Roadmap

This file records the shipped `v0.1.0` baseline and the active `v0.1.1` follow-on work for `@causal-order/monitor`.

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

- Status: `v0.1.0` is the current published package release.
- The `v0.1.0` package exports a real runtime surface instead of a placeholder package shell.
- The published monitor operates with bounded SQLite buffering, health-aware routing, replay coordination, and operator-facing inspection output.
- The current repo state contains additional `v0.1.1` work that has not yet been described here as the published npm baseline.

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

The `v0.1.0` release includes:

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

## Fixed Release Decisions

These behaviors are fixed in the `v0.1.0` release:

- the healthy buffer is always active and rolling for `4h`
- the dual-outage retention ceiling is a hard `6h` maximum
- replay always returns through restored `/dedupe`
- replay failure backs off before retry and keeps live flow gated while backlog recovery is unsettled
- retry-waiting backlog is visible directly in runtime stats and snapshot inspection
- inspection describes operator posture directly instead of only exposing raw replay fields
- downstream consumers can obtain the inspected operator summary directly from runtime surfaces

## Validation Evidence

The `v0.1.0` release is backed by:

- repo-local type validation through `npm run check`
- inspection regression coverage through `npm run test:inspect-snapshot`
- healthy-flow replay guard coverage through `npm run test:no-healthy-replay`
- replay failure and retry safety coverage through `npm run test:replay-safety`
- monitor harness validation through `@causal-order/testing@0.2.6`
- reviewed harness artifacts showing healthy flow, `order_buffer_only`, replay-through-recovery, and drained completion
- verified on-disk SQLite default behavior with bounded retained state available for inspection

## Acceptance Summary

`v0.1.0` is the release where:

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

## `ver0.1.1` Follow-On Scope

`ver0.1.1` should pick up the next layer of package usability and release hardening after the current `v0.1.0` testing work is accepted.

Completed in the current repo state:

- first-class JSON config support so deployers can provide monitor settings from a file instead of only constructing config in code
- optional environment-based config path support for deployment-friendly bootstrapping
- safe merge behavior from JSON config onto package defaults
- convenience runtime and adapter creators for file-backed or environment-backed startup
- operational guidance for deep-outage SQLite write pressure and startup-path suitability
- deterministic 8-node validation for the `4h` rolling window, `6h` hard ceiling, and `202` / `503` ingress contract
- prune hardening so retention-ceiling cleanup happens in manageable batched passes instead of one large lock-heavy sweep
- direct retention/admission contract validation proving `202`, `503`, no `429`, prune-driven cutoff enforcement, and dead-letter evidence
- operational harness suite runners and aggregate validation summaries for repeatable 8-node smoke and fuller production-shaped runs

Still planned in the `v0.1.1` line:

- broader long-duration validation durations beyond the new smoke/full harness suite defaults

Planned scope:

- first-class JSON config support so deployers can provide monitor settings from a file instead of only constructing config in code
- optional environment-based config path support for deployment-friendly bootstrapping
- safe merge behavior from JSON config onto package defaults
- operational guidance for deep-outage SQLite write pressure so deployers size host storage and I/O for worst-case buffered ingress
- prune hardening so retention-ceiling cleanup happens in manageable batches instead of one large lock-heavy sweep

Concrete targets:

- support a package-level config file flow such as `monitor.config.json`
- support an override path such as `CAUSAL_ORDER_MONITOR_CONFIG`
- keep the JSON surface limited to deployer-meaningful settings rather than exposing unstable internal structure
- keep the `v0.1.0` long-duration retention checks as explicit release evidence instead of hand-waving from scaled short-run confidence
- document that deep `full_outage_buffer` periods can turn peak ingress into sustained SQLite write load
- batch prune and purge work so large cohorts aging past `fullOutageMaxWindowMs` do not create avoidable SQLite contention spikes

Acceptance themes:

- a deployer can configure the package without writing custom glue code first
- the roadmap no longer depends on “we ran it manually once” as the main release proof
- `4h` rolling-window and `6h` hard-cap behavior are backed by direct duration testing, not only extrapolation
- deployers have explicit guidance on outage-time disk throughput expectations
- retention enforcement is operationally safe under large backlog cliffs, not just logically correct

Current evidence already added in repo:

- JSON config parsing and validation
- env-driven config resolution with explicit precedence
- runtime and adapter boot helpers for file/env config
- startup SQLite-path failure guidance
- deterministic 8-node threshold validation with artifact output

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

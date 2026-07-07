# Roadmap

This file records the shipped `v0.1.0` state of `@causal-order/monitor`.

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

- Status: `v0.1.0` is the current package release.
- Package metadata, README, changelog, and npm publishing workflow are aligned to `v0.1.0`.
- The package exports a real runtime surface instead of a placeholder package shell.
- The monitor operates with bounded SQLite buffering, health-aware routing, replay coordination, and operator-facing inspection output.

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

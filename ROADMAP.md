# Roadmap

This roadmap is specifically for `@causal-order/monitor`.

It focuses on safe degraded operation first.

The goal is to make `@causal-order/monitor` a deployable recovery envelope around `@causal-order/transport`, `@causal-order/dedupe`, and `causal-order`, not just a dashboard or metrics wrapper.

## Principles

- Prefer conservative recovery behavior over clever but hard-to-trust automation.
- Keep buffering bounded and explicit rather than letting temporary storage quietly become long-term persistence.
- Treat replay safety as more important than replay speed.
- Keep one recovery truth path whenever possible.
- Treat transport outages as a first-class operational signal even when `/monitor` cannot buffer events it never receives.
- Make operator evidence part of the product, not a later cleanup task.
- Align `/monitor` validation with `@causal-order/testing` instead of inventing a separate testing world.

## Current Status

- Version `v0.0.9` is now the active implementation baseline for this repo.
- The package foundation exists:
  - `package.json`
  - TypeScript build config
  - README, changelog, and license
- The design direction is now written down locally:
  - transport-aware topology after `@causal-order/transport`
  - rolling SQLite-backed buffer
  - health-aware routing around `@causal-order/transport`, `/dedupe`, and `causal-order`
  - throttled fallback when `/dedupe` is offline
  - replay-through-dedupe recovery
  - `/testing` harness integration as part of the package story
- The runtime now exists as an active `v0.0.9` implementation line:
  - runtime contracts exported
  - SQLite reservoir implemented
  - health tracking implemented
  - routing and throttle control implemented
  - replay coordination implemented
  - replay retry backoff and failure evidence implemented
  - replay retry inspection surface implemented
  - transport-facing adapter seam added
  - testing scenario catalog added for handoff into `@causal-order/testing`
  - `monitor-order-outage` has now been validated through healthy flow, `order_buffer_only`, replay-through-recovery, and empty-reservoir completion
  - repo-local replay safety validation now proves retry-waiting rows are preserved through rolling prune and only dead-letter at the hard cutoff

## Version `v0.0.9` Decisions

These are fixed for the first implementation line:

- the healthy buffer is always active and rolling for `4h`
- the dual-outage retention ceiling is a hard `6h` maximum
- replay should always return through restored `/dedupe`
- replay failure should back off briefly before retry and keep live flow gated while backlog recovery is still unsettled
- retry-waiting backlog should be visible directly in runtime stats and snapshot inspection

These decisions are intentionally conservative.
They reduce branchy recovery semantics and make the first release easier to reason about under pressure.

## Package Intent

`@causal-order/monitor` is meant to sit inside the existing stack:

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

## `v0.0.9` Release Goal

The first release goal is narrow:

make `/monitor` real enough that we can prove the following end to end:

- healthy rolling buffering works
- transport outage and reconnect bursts are visible and controllable in the operator story
- `/dedupe` failure triggers controlled direct-to-order fallback
- `causal-order` failure triggers backlog accumulation and later recovery
- dual outage remains bounded by the hard `6h` reservoir ceiling
- replay returns through restored `/dedupe`
- `/testing` can validate and report those behaviors

## `v0.0.9` Workstreams

## 1. Runtime Contracts

Build a real public surface for the package instead of a placeholder index.

Required scope:

- `MonitorConfig`
- `MonitorSnapshot`
- `MonitorHealthState`
- replay session snapshot types
- reservoir stats types
- `createMonitorRuntime()`

Exit criteria:

- the package exports an honest runtime API
- the exported names are narrow and intentional
- the README can describe the real package shape without pretending the deeper implementation is done

## 2. SQLite Reservoir

Build the bounded operational storage layer.

Required scope:

- schema bootstrap
- append-first ingress writes
- rolling `4h` retention
- hard `6h` dual-outage maximum
- replay-aware pruning
- lightweight backlog statistics

Required tables:

- `ingress_events`
- `component_health_log`
- `outage_windows`
- `replay_sessions`

Exit criteria:

- ingress can be stored and pruned by window safely
- replay-pinned data is not evicted too early
- backlog size and age can be inspected cheaply

## 3. Health Tracking

Build the state model for `@causal-order/transport`, `/dedupe`, and `causal-order`.

Required scope:

- separate health state for transport
- separate health state for each component
- state transitions:
  - `online`
  - `degraded`
  - `offline`
- combined routing posture
- health transition logging
- outage-window opening and closing

Exit criteria:

- component transitions are explicit and inspectable
- routing posture changes deterministically with health changes
- operator evidence includes when and why routing changed
- transport blackout periods and reconnect bursts are visible in artifacts

## 4. Routing And Throttle Control

Build the failover behavior that matters most during live degradation.

Required routing modes:

- `normal`
- `dedupe_bypass_throttled`
- `order_buffer_only`
- `full_outage_buffer`
- `replay_through_dedupe`

Required throttle tiers:

- `open`
- `slow`
- `very_slow`
- `paused`

Focus:

- direct-to-order fallback must be deliberately slower than the normal path
- the control model should be simple, bounded, and inspectable

Exit criteria:

- dedupe-bypass mode activates a real throttling policy
- backlog and downstream pressure influence routing safely
- live traffic can be paused or slowed during recovery transitions

## 5. Replay Coordination

Build the recovery gate that prevents loose mixing of live traffic and backlog replay.

Required scope:

- replay session lifecycle
- replay start and completion recording
- replay-through-dedupe enforcement
- post-drain health confirmation before reopening live flow

First completion rule:

- replay backlog reaches `0`
- replay session completes without delivery failure
- downstream health remains stable for a short confirmation window

Exit criteria:

- one replay session can be followed end to end in runtime state and artifacts
- live flow does not reopen before recovery is actually complete
- failed replay leaves evidence instead of disappearing into logs

## 6. Operator Inspection

Even without a UI, `v0.0.9` should give maintainers and operators enough evidence to understand behavior.

Required scope:

- runtime snapshot helpers
- health snapshot
- backlog stats
- replay snapshot
- throttle and routing state

Exit criteria:

- a maintainer can answer:
  - which component failed?
  - when did failover begin?
  - how much backlog accumulated?
  - which route is active now?
  - did replay finish?

## 7. `/testing` Harness Integration

`@causal-order/monitor` should be validated through the same deployment-style harness story already used by the ecosystem.

That means:

- extend the provider boundary in `@causal-order/testing`
- add a monitor adapter seam
- add monitor-aware artifacts
- add monitor-aware scenarios and reporting
- validate the monitor story in both transportless deployment-runtime flows and transport-aware adapter-runtime flows

Required first artifact additions:

- `monitor-heartbeats.ndjson`
- `monitor-health.ndjson`
- `monitor-replay.ndjson`
- `monitor-summary.json`

Required first scenarios:

1. healthy rolling reservoir
2. transport outage and reconnect burst visibility
3. `/dedupe` outage with throttle verification
4. `causal-order` outage with buffered recovery
5. dual outage with hard `6h` cap verification
6. recovery-through-dedupe verification

Exit criteria:

- `/testing` can produce monitor-aware artifacts
- monitor failure modes can be exercised without bespoke one-off scripts
- report output can explain recovery behavior in the same ecosystem language as the other packages

## `v0.0.9` Acceptance Criteria

Version `v0.0.9` is done when:

1. the package exports a real runtime API
2. SQLite buffering works with rolling `4h` behavior
3. dual outage enforces a hard `6h` maximum
4. transport health transitions and blackout periods are recorded clearly
5. `/dedupe` outage triggers throttled direct-to-order behavior
6. `causal-order` outage triggers backlog accumulation and later replay
7. replay always routes through restored `/dedupe`
8. live flow does not reopen until replay has completed and health has stabilized briefly
9. `/testing` can validate the major healthy and degraded paths
10. monitor-aware run artifacts and summaries exist
11. replay failure does not immediately churn into uncontrolled retry loops
12. replay retry timing and consecutive failure evidence are visible in runtime state
13. retry-waiting backlog is visible directly from reservoir stats and snapshot inspection helpers
14. a repo-local failure-path test proves retry-waiting rows survive rolling prune and do not replay before the retry horizon

## Next Iteration After `v0.0.9`

The first post-`v0.0.9` line should focus on stack-level validation and operator evidence, not dramatic scope expansion.

Likely next themes:

- carry replay retry and backoff visibility more deeply into `@causal-order/testing` run summaries and comparisons
- run longer harness scenarios that make the real `4h` rolling window and `6h` hard ceiling less synthetic
- add clearer reporting for retry-waiting backlog peaks, replay lag, and catch-up completion time
- refine health heuristics for degraded versus offline states without making routing semantics branchy
- improve replay throughput controls only after the retry/backoff behavior is externally validated enough

It should not immediately jump to:

- dashboard-first scope
- multi-backend storage support
- permanent archival persistence
- distributed monitor federation

## Longer Term

Longer term, `/monitor` should aim to become:

- a deployable ecosystem operator layer
- a trustworthy short-horizon recovery buffer
- a clear source of incident and replay evidence
- a package whose testing story is inseparable from its runtime story

The package is successful if teams can say:

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

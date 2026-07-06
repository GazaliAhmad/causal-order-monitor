# @causal-order/monitor

Health-aware buffering, replay, and operator monitoring layer for the `causal-order` stack.

Status: `v0.0.7` active implementation. Core runtime, SQLite buffering, routing, throttling, replay coordination, and adapter-facing seams now exist, and the first real outage recovery path has been validated and hardened.

## Intended Role

`@causal-order/monitor` is intended to sit after `@causal-order/transport` and around `@causal-order/dedupe` and `causal-order` so the pipeline can degrade and recover more safely when one or more layers become unavailable.

The design direction currently includes:

- health tracking for `@causal-order/transport`
- rolling SQLite-backed buffering
- health tracking for `/dedupe` and `causal-order`
- throttled fallback when `/dedupe` is offline
- replay-through-dedupe recovery
- transport outage visibility and reconnect-burst handling
- operator-facing metrics, traces, and incident timelines

## Version `v0.0.7`

The package has moved beyond scaffold stage and now includes the first working implementation line for the monitor runtime and integration seams.

The current line also includes the first verified recovery fix for replay gating:

- healthy live forwarding now clears delivered rows from replay consideration
- causal-order outage runs can accumulate backlog in `order_buffer_only`
- replay only begins after downstream recovery instead of activating at startup
- validated recovery can drain back to an empty reservoir

Current exported building blocks include:

- `createMonitorRuntime()`
- `MonitorRuntime`
- `SQLiteReservoir`
- `ReplayCoordinator`
- `TransportMonitorAdapter`
- monitor harness scenario metadata for `@causal-order/testing`

The detailed behavior spec still lives in the local design notes for the repo, and the transport/testing integrations should still be treated as `v0.0.7` implementation-stage APIs rather than long-term stable contracts.

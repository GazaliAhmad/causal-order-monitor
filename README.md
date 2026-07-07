# @causal-order/monitor

Health-aware buffering, replay, and operator monitoring for the `causal-order` stack.

Status: `v0.1.0` published to npm.

`@causal-order/monitor` sits between transport ingestion and downstream delivery so your pipeline can keep accepting events, preserve backlog, and recover in a controlled way when `@causal-order/dedupe` or `causal-order` becomes unavailable.

## Install

```bash
npm install @causal-order/monitor better-sqlite3 causal-order @causal-order/dedupe @causal-order/transport
```

`better-sqlite3` is a direct runtime dependency. `causal-order`, `@causal-order/dedupe`, and `@causal-order/transport` are expected alongside this package as peers.

## What It Does

- buffers ingress events in SQLite so downstream outages do not immediately become data loss
- tracks health for `transport`, `dedupe`, and `causal-order`
- switches routing behavior when parts of the stack degrade or go offline
- replays buffered backlog through `@causal-order/dedupe` after recovery
- exposes snapshots and derived inspection state for operators and automation

## Stability

The published npm package is currently `v0.1.0`.

This release includes:

- real harness validation through `@causal-order/testing@0.2.6`
- replay gate and recovery correctness under `causal-order` outage conditions
- on-disk SQLite reservoir defaults for realistic wall-clock retention behavior
- artifact review of backlog accumulation, replay drain, and final reservoir state

## When To Use It

Use this package when you already have a `causal-order` pipeline and want a monitor layer that can:

- keep ingesting while `causal-order` is offline
- throttle or bypass parts of the path when `dedupe` is unhealthy
- coordinate replay after recovery instead of mixing backlog and live flow loosely
- give operators a compact view of backlog, replay, retry, and health state

## Package Model

The package gives you two main integration styles:

- `createMonitorRuntime()` or `MonitorRuntime` if you want direct control over ingress, health updates, replay, and storage
- `TransportMonitorAdapter` if you want a higher-level wrapper that calls your delivery handlers and manages replay pumping through that adapter surface

Other exported building blocks include:

- `HealthTracker`
- `DeliveryRouter`
- `ThrottleController`
- `ReplayCoordinator`
- `SQLiteReservoir`
- `inspectMonitorSnapshot()`

## Subpath Imports

The package now exposes official subpath entrypoints so consumers can import narrower surfaces instead of always pulling from the root package:

- `@causal-order/monitor/config`
- `@causal-order/monitor/health`
- `@causal-order/monitor/inspect`
- `@causal-order/monitor/replay`
- `@causal-order/monitor/routing`
- `@causal-order/monitor/runtime`
- `@causal-order/monitor/storage`
- `@causal-order/monitor/throttle`
- `@causal-order/monitor/transport`
- `@causal-order/monitor/types`

The most lightweight analyzer-friendly entrypoints are:

- `@causal-order/monitor/config`
- `@causal-order/monitor/health`
- `@causal-order/monitor/inspect`
- `@causal-order/monitor/routing`
- `@causal-order/monitor/throttle`
- `@causal-order/monitor/types`

## Quick Start

```ts
import { TransportMonitorAdapter } from "@causal-order/monitor";

const monitor = new TransportMonitorAdapter(
  {
    async deliverToDedupe(event, context) {
      await sendToDedupe(event, context);
    },
    async deliverToOrder(event, context) {
      await sendToCausalOrder(event, context);
    },
    async onBuffered(event, decision, rowId) {
      console.log("buffered", { rowId, action: decision.action, eventId: event.id });
    },
  },
  {
    reservoir: {
      databasePath: "./.causal-order-monitor/monitor.sqlite",
    },
  },
);

monitor.observeHeartbeat("transport");
monitor.observeHeartbeat("dedupe");
monitor.observeHeartbeat("causal-order");

await monitor.ingest({
  id: "evt-1001",
  nodeId: "transport-a",
  clock: {
    physicalTimeMs: BigInt(Date.now()),
  },
  payload: {
    entityId: "order-42",
    operation: "created",
  },
});

const snapshot = monitor.getInspectedSnapshot();
console.log(snapshot.operationalState);
```

## Runtime Example

If you want lower-level control, use the runtime directly:

```ts
import { createMonitorRuntime } from "@causal-order/monitor";

const runtime = createMonitorRuntime({
  reservoir: {
    databasePath: "./.causal-order-monitor/monitor.sqlite",
  },
});

runtime.observeHeartbeat("transport");
runtime.observeHeartbeat("dedupe");
runtime.observeHeartbeat("causal-order");

const { rowId, decision } = runtime.ingestTransportEvent({
  id: "evt-1001",
  nodeId: "transport-a",
  clock: {
    physicalTimeMs: BigInt(Date.now()),
  },
  payload: {
    entityId: "order-42",
    operation: "created",
  },
});

if (decision.action === "accept" && decision.deliveryMode === "normal") {
  await sendToDedupe();
  runtime.acknowledgeIngressDelivery([rowId]);
}
```

## Routing And Recovery Behavior

The monitor can move between a few main operating modes:

- `normal`: live flow goes through dedupe as usual
- `dedupe_bypass_throttled`: live flow can bypass dedupe with throttling when dedupe is unhealthy
- `order_buffer_only`: events are buffered while `causal-order` is offline
- `full_outage_buffer`: events stay buffered during broader outage conditions
- `replay_through_dedupe`: buffered backlog drains through dedupe during recovery

Recovery is intentionally conservative:

- the rolling SQLite buffer defaults to `4h`
- the maximum dual-outage retention window defaults to `6h`
- replay returns through `@causal-order/dedupe`
- replay failure applies a retry backoff before trying again
- live flow stays gated while replay recovery is failed or actively draining

## Configuration

`createDefaultMonitorConfig()` returns the full configuration shape. Common settings:

- `reservoir.databasePath`: SQLite path, default `./.causal-order-monitor/monitor.sqlite`
- `reservoir.rollingBufferWindowMs`: normal rolling retention window
- `reservoir.fullOutageMaxWindowMs`: hard retention ceiling during deeper outages
- `transport.heartbeatGraceMs`: heartbeat grace period before transport is considered stale
- `health.*.degradedAfterMs` and `health.*.offlineAfterMs`: thresholds for each component
- `throttle.*`: ingress limits for each throttle tier
- `replay.healthConfirmationHeartbeats`: heartbeats required before replay resumes
- `replay.pauseLiveFlowDuringReplay`: whether live flow stays gated during drain
- `replay.retryBackoffMs`: delay before retrying a failed replay attempt

If you do not override `reservoir.databasePath`, the package now creates `./.causal-order-monitor/monitor.sqlite` automatically on the host where the monitor runs.

## Inspection And Operator State

For raw state, use:

- `getSnapshot()`
- `getReplaySnapshot()`
- `getReservoirStats()`

For operator-facing state, use:

- `getInspectedSnapshot()`
- `inspectMonitorSnapshot(snapshot)`

The inspected snapshot is the easiest entry point when you want a quick read on:

- current operational posture
- whether live flow is gated
- whether replay is ready or retry-waiting
- backlog size and replay progress
- whether operator attention is needed

## Public Types

Key exported types include:

- `MonitorConfig`
- `MonitorIngressEvent`
- `MonitorIngressDecision`
- `MonitorSnapshot`
- `ReplaySessionSnapshot`
- `ReservoirStats`
- `InspectedMonitorSnapshot`

## Version `v0.1.0`

This release includes:

- defaulting the reservoir to an on-disk SQLite file instead of `:memory:`
- auto-creating the SQLite parent directory for first-run deployment safety
- a local harness wrapper so `@causal-order/testing@0.2.6` can validate this repo's built monitor directly
- a focused healthy-flow regression proving replay does not start incorrectly
- replay gate fixes so live flow does not reopen before required recovery heartbeats and backlog drain are both satisfied
- recovery reconciliation fixes so replay can be re-queued if replay-eligible backlog is still present after an apparent completion
- fast harness validation showing the expected `normal`, `order_buffer_only`, and `replay_through_dedupe` phases with a drained reservoir at completion

## Node Support

- Node.js `>=20`
- ESM package output

## Validation

This package is validated in-repo with:

- `npm run check`
- `npm run test:inspect-snapshot`
- `npm run test:no-healthy-replay`
- `npm run test:replay-safety`
- `npm run harness:monitor -- --monitor-scenario monitor-order-outage --duration 10m --time-scale 60 --profile monitor-order-outage --run-name monitor-order-outage-10m-fast`

## License

MIT

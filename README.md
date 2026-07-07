# @causal-order/monitor

Health-aware buffering, replay, and operator monitoring for the `causal-order` stack.

Status: npm currently publishes `v0.1.0`. The current repo state includes the in-progress `v0.1.1` usability and validation work described below.

`@causal-order/monitor` sits between transport ingestion and downstream delivery so your pipeline can keep accepting events, preserve backlog, and recover in a controlled way when `@causal-order/dedupe` or `causal-order` becomes unavailable.

## Install

```bash
npm install @causal-order/monitor causal-order @causal-order/dedupe @causal-order/transport
```

`@causal-order/monitor` now uses the built-in `node:sqlite` module, so no separate SQLite package is required. `causal-order`, `@causal-order/dedupe`, and `@causal-order/transport` are expected alongside this package as peers.

## What It Does

- buffers ingress events in SQLite so downstream outages do not immediately become data loss
- tracks health for `transport`, `dedupe`, and `causal-order`
- switches routing behavior when parts of the stack degrade or go offline
- replays buffered backlog through `@causal-order/dedupe` after recovery
- exposes snapshots and derived inspection state for operators and automation

## Stability

The published npm package is currently `v0.1.0`.

That published release includes:

- real harness validation through `@causal-order/testing@0.2.6`
- replay gate and recovery correctness under `causal-order` outage conditions
- on-disk SQLite reservoir defaults for realistic wall-clock retention behavior
- artifact review of backlog accumulation, replay drain, and final reservoir state

The current repo state also includes the `v0.1.1` line of work:

- built-in `node:sqlite` instead of `better-sqlite3`
- first-class JSON config loading
- `CAUSAL_ORDER_MONITOR_CONFIG` support
- convenience runtime and adapter bootstrapping from file or environment config
- deterministic 8-node threshold validation for `4h`, `6h`, `202`, and `503` behavior

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

## Ingress HTTP Semantics

If `/monitor` is sitting behind an HTTP ingress boundary, the intended status mapping is:

- `accept` -> `202 Accepted`
- `buffer_only` -> `202 Accepted`
- `pause` -> `503 Service Unavailable`

That means:

- if the event was accepted into the monitor, even if it was only buffered in SQLite, the ingress contract should return `202`
- if the monitor is refusing admission because it is in a true protective stop state, the ingress contract should return `503`

The current monitor semantics do not use `429 Too Many Requests` for ordinary buffering or protective-stop behavior.

## Retention Semantics

The retention boundary is prune-driven, not ingest-driven.

In practical terms:

- the monitor does not immediately hard-reject ingress when the reservoir reaches the `fullOutageMaxWindowMs` ceiling
- it keeps accepting and buffering ingress while routing decisions such as `buffer_only` or `pause` express backpressure posture
- live forwarding stops when the active routing mode requires it
- older unacknowledged rows age out when pruning runs and are marked `dead_letter` once they pass the hard cutoff

So the current behavior is closer to “drop older buffered rows once they age past the ceiling” than “reject every new ingress immediately at the ceiling.”

## Configuration

`createDefaultMonitorConfig()` returns the full configuration shape. Common settings:

- `reservoir.databasePath`: SQLite path, default `./.causal-order-monitor/monitor.sqlite`
- `reservoir.rollingBufferWindowMs`: normal rolling retention window
- `reservoir.fullOutageMaxWindowMs`: hard retention ceiling during deeper outages
- `transport.heartbeatGraceMs`: heartbeat grace period before transport is considered stale
- `reservoir.pruneBatchSize`: maximum number of rows to dead-letter or delete in each SQLite prune batch
- `health.*.degradedAfterMs` and `health.*.offlineAfterMs`: thresholds for each component
- `throttle.*`: ingress limits for each throttle tier
- `replay.healthConfirmationHeartbeats`: heartbeats required before replay resumes
- `replay.pauseLiveFlowDuringReplay`: whether live flow stays gated during drain
- `replay.retryBackoffMs`: delay before retrying a failed replay attempt

If you do not override `reservoir.databasePath`, the package now creates `./.causal-order-monitor/monitor.sqlite` automatically on the host where the monitor runs.

By default, the monitor's internal `now()` clock is wall-clock anchored at startup and then advanced from a monotonic source so it does not move backward during the lifetime of the process. If you provide a custom `now`, you are taking responsibility for that time behavior.

On a server, prefer a host-local writable path such as `/var/lib/causal-order-monitor/monitor.sqlite` or another directory your service account owns. The monitor expects SQLite to run on a normal local filesystem. Avoid read-only mounts, synced workspace folders, and network filesystems unless you have validated them for SQLite locking and durability.

If the reservoir cannot start, the monitor now fails fast with a startup error that includes the resolved SQLite path and deployment guidance instead of only surfacing the raw SQLite exception.

### Deep-Outage Disk I/O Sizing

During a sustained `full_outage_buffer` period, accepted ingress is persisted into SQLite and peak ingress can become sustained local write pressure for hours.

Plan host storage and throughput around the outage worst case, not the healthy-path average.

1. Capacity floor

Treat required local storage as at least:

`peak accepted events/sec * average stored event bytes * 21,600 seconds`

That `21,600` second window is the full `6h` hard-outage horizon.

Example:

- `1,000` accepted events/sec
- `1 KB` average stored event size
- minimum floor of about `21.6 GB`

Treat that as a floor, not a full estimate. Real sizing should add headroom for SQLite metadata, indexes, journaling, filesystem slack, and recovery overlap.

2. Throughput and media choice

- size for peak accepted ingress writes per second across the full `4h` to `6h` outage window
- include SQLite and filesystem overhead such as journaling, checkpoint activity, and indexed writes
- prefer local SSD-class storage such as NVMe or provisioned SSD volumes
- avoid NFS, SMB, synced cloud folders, or other shared/network-backed storage for the live SQLite file
- leave headroom for prune work, replay recovery, and other host processes instead of sizing exactly to the expected steady-state ingress rate
- assume reconnect bursts and uneven node jitter can temporarily raise write pressure above the long-run average

3. Prune and expiry behavior

The `6h` ceiling does not make `/monitor` immediately hard-reject new ingress just because older buffered rows have reached the maximum retention window.

Instead:

- routing decisions still determine whether the monitor continues to accept or buffer ingress
- older buffered rows age out when pruning runs
- rows that have crossed the hard cutoff are marked `dead_letter`
- in `v0.1.1`, prune performs this work in indexed batches instead of one large sweep

That means large expiry cliffs can still create predictable background write spikes. A reasonable operational target is to leave at least `20%` I/O headroom so prune and live ingress can overlap without destabilizing the host, but that is a sizing guideline, not a guarantee.

Operationally, deployers should watch for:

- SQLite file growth that outpaces expected backlog math
- backlog age increasing faster than downstream recovery can drain it
- host-level disk queueing, latency spikes, or noisy-neighbor contention
- prune or replay phases overlapping with continued ingress during recovery

If the host cannot sustain that write profile, the monitor may still preserve correctness semantics while becoming operationally fragile under deep outage pressure.

You can also load deployer-facing settings from a JSON file:

```ts
import { loadMonitorConfigFile, createMonitorRuntime } from "@causal-order/monitor";

const config = loadMonitorConfigFile("monitor.config.json");
const runtime = createMonitorRuntime(config);
```

For deployments that do not want to hardcode the config path, the package also supports `CAUSAL_ORDER_MONITOR_CONFIG`:

```ts
import {
  createMonitorRuntime,
  loadMonitorConfigFromEnvironment,
} from "@causal-order/monitor";

const config = loadMonitorConfigFromEnvironment();
const runtime = createMonitorRuntime(config);
```

If you want to skip the separate load step entirely, the package now exposes convenience creators for both the runtime and the transport adapter:

```ts
import {
  createMonitorRuntimeFromEnvironment,
  createTransportMonitorAdapterFromFile,
} from "@causal-order/monitor";

const runtime = createMonitorRuntimeFromEnvironment();

const adapter = createTransportMonitorAdapterFromFile(
  {
    async deliverToDedupe(event, context) {
      await sendToDedupe(event, context);
    },
    async deliverToOrder(event, context) {
      await sendToCausalOrder(event, context);
    },
  },
  "/etc/causal-order/monitor.config.json",
);
```

Config precedence is:

1. explicit in-code config passed to `resolveMonitorConfigFromEnvironment(inlineConfig, ...)`
2. config file path from `CAUSAL_ORDER_MONITOR_CONFIG`
3. default `monitor.config.json` in the current working directory, if present
4. package defaults

If `CAUSAL_ORDER_MONITOR_CONFIG` is set, the monitor treats that as authoritative and fails clearly if the file cannot be loaded.

Supported duration values in JSON can be either integer milliseconds or strings like `15000ms`, `30s`, `5m`, or `4h`.

Example `monitor.config.json`:

```json
{
  "reservoir": {
    "databasePath": "/var/lib/causal-order-monitor/monitor.sqlite",
    "rollingBufferWindowMs": "4h",
    "fullOutageMaxWindowMs": "6h",
    "pruneIntervalMs": "60s",
    "pruneBatchSize": 1000
  },
  "transport": {
    "heartbeatGraceMs": "15s",
    "reconnectBurstWindowMs": "30s",
    "sourceLabel": "@causal-order/transport"
  },
  "health": {
    "transport": {
      "degradedAfterMs": "10s",
      "offlineAfterMs": "30s"
    },
    "dedupe": {
      "degradedAfterMs": "10s",
      "offlineAfterMs": "30s"
    },
    "causalOrder": {
      "degradedAfterMs": "10s",
      "offlineAfterMs": "30s"
    }
  },
  "throttle": {
    "defaultTier": "open",
    "open": {
      "maxEventsPerSecond": 5000,
      "batchSize": 500
    },
    "slow": {
      "maxEventsPerSecond": 1000,
      "batchSize": 200
    },
    "verySlow": {
      "maxEventsPerSecond": 250,
      "batchSize": 50
    },
    "paused": {
      "maxEventsPerSecond": 0,
      "batchSize": 0
    }
  },
  "replay": {
    "healthConfirmationHeartbeats": 2,
    "pauseLiveFlowDuringReplay": true,
    "retryBackoffMs": "5s"
  }
}
```

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

The published release includes:

- defaulting the reservoir to an on-disk SQLite file instead of `:memory:`
- auto-creating the SQLite parent directory for first-run deployment safety
- a local harness wrapper so `@causal-order/testing@0.2.6` can validate this repo's built monitor directly
- a focused healthy-flow regression proving replay does not start incorrectly
- replay gate fixes so live flow does not reopen before required recovery heartbeats and backlog drain are both satisfied
- recovery reconciliation fixes so replay can be re-queued if replay-eligible backlog is still present after an apparent completion
- fast harness validation showing the expected `normal`, `order_buffer_only`, and `replay_through_dedupe` phases with a drained reservoir at completion

## Current `v0.1.1` Work In Repo

The current repo state additionally includes:

- migration from `better-sqlite3` to built-in `node:sqlite`
- path-specific SQLite startup guidance for deployment failures
- JSON config loading through `monitor.config.json`
- config precedence across inline config, `CAUSAL_ORDER_MONITOR_CONFIG`, default config file discovery, and package defaults
- convenience creators for file-backed and environment-backed runtime or adapter boot
- deterministic 8-node validation covering `4h` rolling retention, `6h` hard-outage retention, and the `202` / `503` ingress contract

## Node Support

- Node.js `>=22.13.0`
- ESM package output

## Validation

This package is validated in-repo with:

- `npm run check`
- `npm run test:config-env-resolution`
- `npm run test:http-thresholds-8nodes`
- `npm run test:inspect-snapshot`
- `npm run test:monitor-operational-smoke`
- `npm run test:monotonic-now`
- `npm run test:no-healthy-replay`
- `npm run test:monitor-operational-full`
- `npm run test:prune-batching`
- `npm run test:retention-admission-contract`
- `npm run test:runtime-bootstrap`
- `npm run test:replay-safety`
- `npm run harness:monitor -- --monitor-scenario monitor-order-outage --duration 10m --time-scale 60 --profile monitor-order-outage --run-name monitor-order-outage-10m-fast`

The `test:http-thresholds-8nodes` validation is a deterministic 8-node wall-clock simulation that proves:

- order-only outage still returns monitor decisions equivalent to HTTP `202 Accepted` after the `4h` rolling window, while prune ages out old buffered rows
- dual outage still returns monitor decisions equivalent to HTTP `202 Accepted` after the `6h` ceiling, with dead-lettering happening during prune rather than immediate ingress rejection
- true monitor protective-stop behavior maps to HTTP `503 Service Unavailable` when dedupe-only bypass pressure crosses the hard backlog threshold

The operational harness suites are:

- `npm run test:monitor-operational-smoke`
  Uses an 8-node default topology and a short scenario subset intended for CI and repeatable smoke confidence.
- `npm run test:monitor-operational-full`
  Uses an 8-node default topology and the broader monitor scenario set for production-shaped validation runs.

Both suite runners write a manifest and aggregate summary into `artifacts/validation/` so artifact review does not depend on manually opening each run directory one by one.

## License

MIT

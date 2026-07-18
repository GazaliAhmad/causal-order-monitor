# Configuration Reference

This reference covers configuration loading, defaults, precedence, duration parsing, and runtime bootstrap for `@causal-order/monitor`.

## Bootstrap Paths

For most deployments, use one of these paths:

1. `loadMonitorConfigFile()` or `loadMonitorConfigFromEnvironment()` for an explicit loading step.
2. `createMonitorRuntimeFromFile()` or `createMonitorRuntimeFromEnvironment()` for direct manual-runtime bootstrap.
3. `createTransportMonitorAdapterFromFile()` or `createTransportMonitorAdapterFromEnvironment()` for the preferred adapter integration with file or environment configuration.

`resolveMonitorConfig()` and `resolveMonitorConfigFromEnvironment()` remain public for advanced composition. `createDefaultMonitorConfig()` returns the complete resolved configuration.

## Fields and Defaults

| Field | Default | Meaning |
| --- | --- | --- |
| `reservoir.databasePath` | `./.causal-order-monitor/monitor.sqlite` resolved to an absolute path | SQLite reservoir path |
| `reservoir.rollingBufferWindowMs` | `4h` | Normal rolling retention window |
| `reservoir.fullOutageMaxWindowMs` | `6h` | Hard pending-retention ceiling during deeper outages |
| `reservoir.pruneIntervalMs` | `60s` | Caller-facing prune cadence setting |
| `reservoir.pruneBatchSize` | `1000` | Maximum transitions and deletions per prune call |
| `reservoir.deliveredRetentionMs` | `24h` | Delivered evidence retention |
| `reservoir.deadLetterRetentionMs` | `168h` | Dead-letter evidence retention |
| `reservoir.walAutoCheckpointPages` | `1000` | SQLite automatic WAL checkpoint threshold; `0` disables it |
| `transport.heartbeatGraceMs` | `15s` | Transport heartbeat grace period |
| `transport.reconnectBurstWindowMs` | `30s` | Reconnect burst observation window |
| `transport.sourceLabel` | `@causal-order/transport` | Transport source label |
| `health.*.degradedAfterMs` | `10s` | Component degraded threshold |
| `health.*.offlineAfterMs` | `30s` | Component offline threshold |
| `throttle.defaultTier` | `open` | Initial throttle tier |
| `throttle.open` | `5000/s`, batch `500` | Open tier |
| `throttle.slow` | `1000/s`, batch `200` | Slow tier |
| `throttle.verySlow` | `250/s`, batch `50` | Very-slow tier |
| `throttle.paused` | `0/s`, batch `0` | Paused tier |
| `replay.healthConfirmationHeartbeats` | `2` | Recovery observations required before replay |
| `replay.pauseLiveFlowDuringReplay` | `true` | Whether replay drain gates live flow |
| `replay.retryBackoffMs` | `5s` | Failed replay retry delay |
| `startup.healthPolicy` | `optimistic` | Startup forwarding policy |

The default database parent directory is created automatically. `startup.healthPolicy: "conservative"` keeps ingress buffered until online evidence has been observed for transport, dedupe, and causal-order. That startup gate is separate from replay recovery confirmation and does not bypass restart backlog protection.

## Complete JSON Example

```json
{
  "reservoir": {
    "databasePath": "/var/lib/causal-order-monitor/monitor.sqlite",
    "rollingBufferWindowMs": "4h",
    "fullOutageMaxWindowMs": "6h",
    "pruneIntervalMs": "60s",
    "pruneBatchSize": 1000,
    "deliveredRetentionMs": "24h",
    "deadLetterRetentionMs": "168h",
    "walAutoCheckpointPages": 1000
  },
  "transport": {
    "heartbeatGraceMs": "15s",
    "reconnectBurstWindowMs": "30s",
    "sourceLabel": "@causal-order/transport"
  },
  "health": {
    "transport": { "degradedAfterMs": "10s", "offlineAfterMs": "30s" },
    "dedupe": { "degradedAfterMs": "10s", "offlineAfterMs": "30s" },
    "causalOrder": { "degradedAfterMs": "10s", "offlineAfterMs": "30s" }
  },
  "throttle": {
    "defaultTier": "open",
    "open": { "maxEventsPerSecond": 5000, "batchSize": 500 },
    "slow": { "maxEventsPerSecond": 1000, "batchSize": 200 },
    "verySlow": { "maxEventsPerSecond": 250, "batchSize": 50 },
    "paused": { "maxEventsPerSecond": 0, "batchSize": 0 }
  },
  "replay": {
    "healthConfirmationHeartbeats": 2,
    "pauseLiveFlowDuringReplay": true,
    "retryBackoffMs": "5s"
  },
  "startup": { "healthPolicy": "optimistic" }
}
```

JSON duration values may be integer milliseconds or strings such as `15000ms`, `30s`, `5m`, or `4h`.

## Loading Configuration

```ts
import { loadMonitorConfigFile, createMonitorRuntime } from "@causal-order/monitor";

const config = loadMonitorConfigFile("monitor.config.json");
const runtime = createMonitorRuntime(config);
```

Set `CAUSAL_ORDER_MONITOR_CONFIG` when the path should come from the environment:

```ts
import {
  createMonitorRuntime,
  loadMonitorConfigFromEnvironment,
} from "@causal-order/monitor";

const config = loadMonitorConfigFromEnvironment();
const runtime = createMonitorRuntime(config);
```

Or use the convenience creators:

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

## Precedence and Failure Behavior

Configuration precedence is:

1. Explicit in-code config passed to `resolveMonitorConfigFromEnvironment(inlineConfig, ...)`.
2. The file named by `CAUSAL_ORDER_MONITOR_CONFIG`.
3. `monitor.config.json` in the current working directory, when present.
4. Package defaults.

An explicitly set `CAUSAL_ORDER_MONITOR_CONFIG` is authoritative and fails clearly if it cannot be loaded. Reservoir startup failures include the resolved SQLite path and deployment guidance.

## Clock Behavior

The default `now()` is wall-clock anchored at startup and advances from a monotonic source, so it does not move backward during the process lifetime. Supplying a custom `now` transfers responsibility for that behavior to the caller. `createDefaultMonitorNow()` exposes the default factory for lower-level composition; most integrations do not need it.

Storage placement and WAL tuning are covered in [deployment](deployment.md) and [persistence operations](persistence-operations.md).

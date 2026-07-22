# @causal-order/monitor

Keep accepting events during bounded downstream outages, persist them locally, and replay them through deduplication before causal ordering resumes. `@causal-order/monitor` adds health-aware routing, controlled recovery, and operator visibility to a `causal-order` pipeline.

Published package version: `v0.6.0`

## Stack Position

```text
@causal-order/transport -> @causal-order/monitor -> @causal-order/dedupe -> causal-order
```

The monitor owns ingress buffering, degraded routing, and controlled replay between transport and downstream delivery. Buffered events always re-enter the normal downstream path through `@causal-order/dedupe` before causal ordering.

`SQLiteReservoir` is owned entirely by this package and serves bounded ingress buffering and replay. It is not a general persistence adapter for component WALs, checkpoints, or state; its data, schema, lifecycle, and API are specific to the monitor.

## Install and Requirements

```bash
npm install @causal-order/monitor causal-order @causal-order/dedupe @causal-order/transport
```

- Node.js `>=22.13.0`
- ESM-only output
- built-in `node:sqlite`; no separate SQLite package is required

| Package | Supported versions | Role |
| --- | --- | --- |
| `@causal-order/transport` | `^0.2.0` | Runtime peer |
| `@causal-order/dedupe` | `^1.1.1` | Runtime peer and replay path |
| `causal-order` | `^1.0.0` | Runtime peer |

The basic monitor graph does not depend on `@causal-order/testing`. The downstream testing release is `@causal-order/testing@0.3.1`; its qualification uses transport `0.2.x` and exact published monitor `0.6.0` before testing is released through its own publication process.

## When to Use It

Use the monitor when an existing `causal-order` pipeline needs to:

- continue accepting events during bounded downstream outages
- buffer ingress safely on local storage
- coordinate recovery instead of mixing backlog and live flow loosely
- replay buffered work through dedupe before causal ordering
- expose health, admission, backlog, replay, and storage state to operators or automation

### When Not to Use It

The monitor is not:

- a distributed queue or indefinite-retention system
- a multi-writer coordination system, cross-process lock, or leader-election mechanism
- permission for multiple processes to share one live reservoir
- a replacement for application-owned event-lateness policy

## Integration Model

`TransportMonitorAdapter` is the preferred application integration. It calls application-provided delivery handlers, acknowledges successful delivery, and manages replay through the adapter surface.

Use `MonitorRuntime` only when deliberate manual control over ingress, health, replay, and storage is required. Adapter-managed replay and manual runtime replay must not be mixed on the same runtime; invalid mixed control fails with `ReplayOwnershipError`.

One live SQLite reservoir has one owning `MonitorRuntime` or `TransportMonitorAdapter` process. Adapter call serialization is process-local; it is not a cross-process lock, leader-election mechanism, or coordination mechanism for other runtimes or processes.

See the [API reference](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/api-reference.md) for the lower-level runtime example, scheduler, and replay-operation details.

## Quick Start

```ts
import {
  createDefaultMonitorConfig,
  TransportMonitorAdapter,
} from "@causal-order/monitor";

const config = createDefaultMonitorConfig();
config.reservoir.databasePath = "./.causal-order-monitor/monitor.sqlite";

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
  config,
);

try {
  monitor.observeHeartbeat("transport");
  monitor.observeHeartbeat("dedupe");
  monitor.observeHeartbeat("causal-order");

  await monitor.ingest({
    id: "evt-1001",
    nodeId: "transport-a",
    clock: { physicalTimeMs: BigInt(Date.now()) },
    payload: { entityId: "order-42", operation: "created" },
  });

  const operator = monitor.getOperatorSnapshot();
  console.log(operator.status, operator.backlog);
} finally {
  monitor.close();
}
```

`sendToDedupe` and `sendToCausalOrder` are application-owned delivery functions. The first is the normal and replay route; the second is used only when the routing decision permits throttled dedupe bypass.

## Core Behavior

### Routing and Recovery

- `normal`: live events flow through dedupe
- `dedupe_bypass_throttled`: live events may bypass unhealthy dedupe under throttling
- `order_buffer_only`: events remain buffered while causal ordering is unavailable
- `full_outage_buffer`: events remain buffered during a wider outage
- `replay_through_dedupe`: recovery backlog drains through dedupe

Replay waits for configured recovery confirmation. Failures apply retry backoff, and live flow remains gated during pre-replay confirmation, retry waiting, active drain, and post-replay confirmation. Replay always returns through dedupe.

### Admission and HTTP Mapping

| Outcome | HTTP status |
| --- | --- |
| Accepted live work | `202 Accepted` |
| Accepted buffered work | `202 Accepted` |
| Protective refusal | `503 Service Unavailable` |

`TransportMonitorAdapter.ingest()` returns an `admission` object for accepted work. Routing-policy refusal throws `MonitorAdmissionRefusedError` before persistence, with code `ERR_MONITOR_ADMISSION_REFUSED` and `httpStatus: 503`. Configured logical-capacity or filesystem-reserve refusal instead throws `MonitorCapacityRefusedError`, with code `ERR_MONITOR_CAPACITY_REFUSED`, `httpStatus: 503`, the limiting dimension, stable reason evidence, and retry guidance. Neither refusal persists the rejected event.

Ordinary buffering and protective stops—including configured reservoir-capacity refusal—do not use `429`; protective refusal uses `503`. Client-, tenant-, and commercial-quota or rate-limit policies remain outside the monitor’s scope and should be enforced by the application or API gateway.

### Retention

Retention is prune-driven, not ingest-driven. Reaching `fullOutageMaxWindowMs` does not by itself reject every new event. When pruning runs, expired pending rows become `dead_letter`; delivered and dead-letter evidence then follow independent retention clocks. Each prune call bounds both transitions and deletions by `pruneBatchSize`, so large cleanup sets need repeated calls.

## Configuration Summary

Common settings are:

- `reservoir.databasePath`, `rollingBufferWindowMs`, and `fullOutageMaxWindowMs`
- `reservoir.pruneBatchSize`, `deliveredRetentionMs`, and `deadLetterRetentionMs`
- `reservoir.capacity.*` logical limits and optional filesystem reserve
- `health.*.degradedAfterMs` and `health.*.offlineAfterMs`
- `throttle.*` tier limits
- `replay.healthConfirmationHeartbeats` and `replay.retryBackoffMs`
- `startup.healthPolicy`: `"optimistic"` or `"conservative"`

```json
{
  "reservoir": {
    "databasePath": "/var/lib/causal-order-monitor/monitor.sqlite",
    "rollingBufferWindowMs": "4h",
    "fullOutageMaxWindowMs": "6h",
    "pruneBatchSize": 1000,
    "deliveredRetentionMs": "24h",
    "deadLetterRetentionMs": "168h"
  },
  "replay": {
    "healthConfirmationHeartbeats": 2,
    "retryBackoffMs": "5s"
  },
  "startup": { "healthPolicy": "conservative" }
}
```

See the [configuration reference](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/configuration.md) for all fields, defaults, duration parsing, precedence, bootstrap helpers, and clock behavior.

## Operational Constraints

- Give each live reservoir exactly one owning process.
- Use host-local writable storage; network and synced filesystems are not recommended.
- Size storage and write throughput for outage ingestion, replay overlap, pruning, SQLite metadata, indexes, and WAL activity.
- Treat the monitor as bounded recovery infrastructure, not unlimited durable queueing.

See [deployment guidance](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/deployment.md), [persistence operations](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/persistence-operations.md), and the [operator runbook](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/operator-runbook.md).

## Operator Snapshot

`getOperatorSnapshot()` is the preferred machine-consumable interface:

```json
{
  "schema": "causal-order-monitor/operator-snapshot",
  "version": 1
}
```

Its contract is directly JSON-serializable; millisecond and byte quantities are represented as decimal strings. It exposes health, admission, backlog, replay, and bounded storage state. Consumers must check both discriminator fields before interpreting the snapshot. See the [operator snapshot migration guide](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/migrations/operator-snapshot-v1.md) for the older unversioned inspection surface.

Capacity has a separate versioned inspection surface at `monitor.capacity.getSnapshot()`. It reports configured logical/reserve limits, usage, utilization, filesystem evidence, last refusal, and bounded process counters without changing the operator snapshot v1 shape.

Runtime and adapter owners also share a typed `monitor.lifecycle` facet for bounded, non-awaited operational observations. Listeners are failure-isolated, evidence is immutable and payload-free, slow observers cause inspectable `drop_oldest` overflow rather than unbounded queue growth, and `flush()` provides an explicit bounded best-effort drain before close. Lifecycle observations are not durable audit or recovery authority.

Version 0.5.0 emits the 20-event catalog from truthful runtime, adapter, replay, retention, health, pressure, checkpoint, and scheduler boundaries. Handler completion remains distinct from committed delivery acknowledgement, and indeterminate accepted outcomes remain storage-reconciliation cases.

## Subpath Imports

Official advanced surfaces should be imported from their published subpaths.

| Subpath | Purpose |
| --- | --- |
| `@causal-order/monitor/config` | Configuration |
| `@causal-order/monitor/health` | Health tracking |
| `@causal-order/monitor/inspect` | Snapshot inspection |
| `@causal-order/monitor/replay` | Replay coordination |
| `@causal-order/monitor/routing` | Delivery routing |
| `@causal-order/monitor/runtime` | Manual runtime integration |
| `@causal-order/monitor/scheduler` | Reference scheduler |
| `@causal-order/monitor/storage` | SQLite reservoir primitives |
| `@causal-order/monitor/testing` | Harness metadata |
| `@causal-order/monitor/throttle` | Throttle decisions |
| `@causal-order/monitor/transport` | Preferred adapter integration |
| `@causal-order/monitor/types` | TypeScript contracts |

See [root-to-subpath migrations](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/migrations/root-subpaths.md) for compatibility history.

## Documentation

- [API reference](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/api-reference.md)
- [Configuration reference](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/configuration.md)
- [Deployment guide](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/deployment.md)
- [Persistence operations](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/persistence-operations.md)
- [Operator runbook](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/operator-runbook.md)
- [Schema compatibility](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/schema-compatibility.md)
- [Root-to-subpath migration](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/migrations/root-subpaths.md)
- [Operator snapshot v1 migration](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/migrations/operator-snapshot-v1.md)
- [Timing evidence](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/timing-evidence.md)
- [Performance baselines](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/performance-baselines.md)
- [Sustained-load and soak qualification](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/docs/soak-qualification.md)
- [Validation guide and evidence](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/VALIDATION.md)
- [Release history](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/CHANGELOG.md)

## License

[MIT](https://github.com/GazaliAhmad/causal-order-monitor/blob/main/LICENSE)

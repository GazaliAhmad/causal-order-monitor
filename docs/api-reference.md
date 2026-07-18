# API Reference

This page maps the main integration surfaces and supported advanced exports. TypeScript declarations shipped with the package remain the exact signature reference.

## Primary Integration

Use `TransportMonitorAdapter` for normal application integrations. Application handlers implement `deliverToDedupe`, `deliverToOrder`, and optional decision, buffering, or replay-state callbacks. The adapter persists ingress before delivery, acknowledges successful work, and owns replay orchestration for its runtime.

Concurrent `pumpReplayBatch()` and `reconcileRecovery()` calls on one adapter coalesce onto the same in-flight replay operation. The first call's batch limit governs it, and all callers receive its result. This serialization is adapter-local, not a cross-process coordination mechanism.

Use `MonitorRuntime` only for intentional manual orchestration. An adapter-managed runtime rejects direct manual replay with `ReplayOwnershipError`.

## Lower-Level Runtime Example

```ts
import {
  createDefaultMonitorConfig,
  createMonitorRuntime,
} from "@causal-order/monitor";

const config = createDefaultMonitorConfig();
config.reservoir.databasePath = "./.causal-order-monitor/monitor.sqlite";
const runtime = createMonitorRuntime(config);

try {
  runtime.observeHeartbeat("transport");
  runtime.observeHeartbeat("dedupe");
  runtime.observeHeartbeat("causal-order");

  const { rowId, decision } = runtime.ingestTransportEvent({
    id: "evt-1001",
    nodeId: "transport-a",
    clock: { physicalTimeMs: BigInt(Date.now()) },
    payload: { entityId: "order-42", operation: "created" },
  });

  if (decision.action === "accept" && decision.deliveryMode === "normal") {
    await sendToDedupe();
    runtime.acknowledgeIngressDelivery([rowId]);
  }
} finally {
  runtime.close();
}
```

Manual integrations own the relationship between the decision, external delivery, acknowledgement, recovery reconciliation, and replay. Prefer the adapter unless that ownership is deliberate.

## Reference Scheduler

`MonitorScheduler` from `@causal-order/monitor/scheduler` is an optional caller-owned scheduler around one adapter. It serializes application-provided health probes, replay reconciliation, and bounded pruning; respects persisted retry deadlines; and stops idempotently.

Health probing remains application-owned. Stopping the scheduler does not close the adapter unless `closeAdapterOnStop: true` is configured. Attach only one scheduler to the owning adapter.

## Inspection

Raw and compatibility surfaces include:

- `getSnapshot()`
- `getReplaySnapshot()`
- `getReservoirStats()`
- `getReservoirLifecycleStats()` for delivered and dead-letter counts
- `checkpointReservoirWal()` for explicit WAL maintenance results
- `getInspectedSnapshot()`
- `inspectMonitorSnapshot(snapshot)`

The preferred operator surfaces are:

- `getOperatorSnapshot()`
- `inspectMonitorSnapshotV1(snapshot, storage?)`

They produce the discriminated, JSON-safe operator snapshot documented in the [migration guide](migrations/operator-snapshot-v1.md).

## Published Subpaths

| Subpath | Purpose |
| --- | --- |
| `@causal-order/monitor/config` | Configuration loading and helpers |
| `@causal-order/monitor/health` | Health tracking |
| `@causal-order/monitor/inspect` | Snapshot inspection |
| `@causal-order/monitor/replay` | Replay coordination contracts |
| `@causal-order/monitor/routing` | Delivery routing |
| `@causal-order/monitor/runtime` | Lower-level runtime integration |
| `@causal-order/monitor/scheduler` | Reference scheduler |
| `@causal-order/monitor/storage` | SQLite reservoir primitives |
| `@causal-order/monitor/testing` | Harness metadata |
| `@causal-order/monitor/throttle` | Throttle decisions |
| `@causal-order/monitor/transport` | Preferred adapter integration |
| `@causal-order/monitor/types` | TypeScript contracts |

Official advanced surfaces should be imported from these entrypoints. Historical root compatibility is covered in [root-to-subpath migration](migrations/root-subpaths.md).

## Public Types

Key exported types include:

- `MonitorConfig`
- `MonitorIngressEvent`
- `MonitorIngressDecision`
- `MonitorEventTimingEvidence`
- `MonitorSnapshot`
- `ReplaySessionSnapshot`
- `ReservoirStats`
- `InspectedMonitorSnapshot`

## Specialist and Compatibility Surfaces

- `SQLiteReservoir` is the supported specialist runtime-building surface.
- `monitorHarnessArtifacts`, `monitorHarnessScenarios`, and harness metadata types are testing-oriented and available through `@causal-order/monitor/testing`.
- `monitorPackageVersion` and `monitorImplementationStatus` are compatibility-only metadata exports.

These remain part of the public compatibility contract and follow semantic-versioning guarantees.

## Lifecycle and Ownership

One live reservoir has one owning `MonitorRuntime`, or one adapter built on that runtime. Stop and close the owner before backup, restore, relocation, or restart. `SQLiteReservoir.close()`, `MonitorRuntime.close()`, and `TransportMonitorAdapter.close()` are idempotent; mutable work after close is rejected.

See [persistence operations](persistence-operations.md) for storage lifecycle and [schema compatibility](schema-compatibility.md) for restart reconstruction.

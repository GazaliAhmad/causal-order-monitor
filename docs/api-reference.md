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

## Capacity Refusal

Opt-in logical limits refuse before an ingress row is persisted. `MonitorRuntime.ingestTransportEvent()` and `TransportMonitorAdapter.ingest()` surface `MonitorCapacityRefusedError` directly with:

- code `ERR_MONITOR_CAPACITY_REFUSED`;
- HTTP status `503`;
- limiting dimension and stable reason code;
- JSON-safe decimal-string `limit`, `current`, and `attempted` values;
- `reduce_event_size` for a non-retryable oversized event, or `retry_when_capacity_available` for retryable pending row/byte pressure.

The limiting dimensions are `serialized_event_bytes`, `pending_rows`, `pending_serialized_bytes`, `filesystem_reserve`, and `filesystem_evidence_unavailable`. Filesystem refusals recommend either `free_local_storage_then_retry` or `restore_capacity_evidence_then_retry`. Refusal returns no row identity and leaves both ingress storage and accounting unchanged. It remains distinct from `SQLITE_FULL`, read-only, contention, and I/O failures. See [configuration](configuration.md) for limits and exact boundary semantics.

## Reference Scheduler

`MonitorScheduler` from `@causal-order/monitor/scheduler` is an optional caller-owned scheduler around one adapter. It serializes application-provided health probes, replay reconciliation, and bounded pruning; skips replay attempts while dedupe or causal-order is offline; respects persisted retry deadlines; and stops idempotently.

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

Capacity inspection is a separate additive facet on `MonitorRuntime`, `TransportMonitorAdapter`, and `SQLiteReservoir`:

```ts
const capacity = monitor.capacity.getSnapshot();
// capacity.schema === "causal-order-monitor/capacity-snapshot"
// capacity.version === 1
```

The JSON-safe snapshot reports admission posture, configured limits, logical usage and utilization, physical database/WAL/filesystem evidence, the last refusal, and process-lifetime refusal/storage-append-failure counters. Inspection reads singleton accounting plus bounded file metadata and excludes payloads. The adapter facet is the same object as its managed runtime facet. Closing the owner also closes capacity inspection. The existing operator snapshot v1 shape is unchanged.

## Lifecycle Observations

`MonitorRuntime` and `TransportMonitorAdapter` expose the same owner-backed `lifecycle` facet. Subscribe by typed event name; listeners may be synchronous or asynchronous and unsubscription is idempotent:

Runtime, adapter, replay, retention, health, capacity/storage inspection, checkpoint, and scheduler paths publish the 20-event catalog at their truthful boundaries. Ingress acceptance, delivery acknowledgement, replay claim/acknowledgement, dead-lettering, deletion, health persistence, and replay-state changes are emitted only after the corresponding SQLite operation returns successfully.

```ts
const unsubscribe = monitor.lifecycle.subscribe(
  "deliveryAcknowledged",
  (evidence) => recordAcknowledgement(evidence.rowId, evidence.durationMs),
);

const snapshot = monitor.lifecycle.getSnapshot();
// snapshot.schema === "causal-order-monitor/lifecycle-snapshot"
// snapshot.version === 1

await monitor.lifecycle.flush();
unsubscribe();
monitor.close();
```

Monitor operations enqueue observations synchronously and never await listeners. One bounded FIFO dispatches events in enqueue order, waiting for the selected listeners for one event to settle before advancing; listeners selected for that event run concurrently. Listener throws and rejected promises are counted and isolated. At capacity, `drop_oldest` removes the oldest observation that has not begun dispatch. Snapshot v1 reports status, queue depth/capacity, subscriber count, drops, listener failures, and last-drop evidence.

Evidence is copied and deeply frozen at enqueue time. The typed event model excludes `payload`, `payloadJson`, and `serializedEvent`; the dispatcher also removes those fields defensively. Per-row order follows owner enqueue order, but no durable, cross-process, or total semantic ordering is promised. This is best-effort operational observation, not a compliance audit or recovery authority.

The catalog groups facts as follows:

- ingress: `ingressAttempted`, `ingressAccepted`, `ingressRefused`, and `storageAppendFailed`;
- delivery: `deliveryAttempted`, `deliveryHandlerCompleted`, `deliveryAcknowledged`, `deliveryFailed`, and `deliveryIndeterminate`;
- replay and retention: replay state/claim/acknowledgement/failure plus dead-letter and terminal deletion facts;
- operations: health changes, storage/capacity pressure, checkpoint completion, and operation durations.

`deliveryHandlerCompleted` means only that the application handler resolved. `deliveryAcknowledged` is the later committed SQLite boundary. Handler rejection produces `deliveryFailed`; accepted work whose adapter completion or acknowledgement cannot be observed produces `deliveryIndeterminate` and remains subject to storage reconciliation.

Call `flush()` before `close()` when best-effort delivery of queued observations matters. Flush is bounded by its explicit argument or `lifecycle.shutdownFlushTimeoutMs`. Synchronous close admits no new observations, counts queued observations as shutdown drops, clears subscriptions, and does not wait for an active listener. Subscription after close throws `MonitorClosedError`; snapshot and flush remain available to report the closed state.

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
- `MonitorCapacityConfig`
- `MonitorFilesystemReserveConfig`
- `MonitorCapacityFacet`
- `MonitorCapacitySnapshotV1`
- `MonitorCapacityRefusalEvidence`
- `MonitorLifecycleConfig`
- `MonitorLifecycleEvents`
- `MonitorLifecycleEventName`
- `MonitorLifecycleFacet`
- `MonitorLifecycleSnapshotV1`
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

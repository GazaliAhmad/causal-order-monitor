# Operator Snapshot v1 Migration

`getOperatorSnapshot()` is the preferred versioned, JSON-safe operator contract. The older `getInspectedSnapshot()` and `inspectMonitorSnapshot()` surfaces remain compatibility APIs and use BigInt values.

## Discriminator

Check both fields before interpreting a snapshot:

```ts
const operator = monitor.getOperatorSnapshot();
if (
  operator.schema !== "causal-order-monitor/operator-snapshot" ||
  operator.version !== 1
) {
  throw new Error("Unsupported monitor operator snapshot");
}
```

## Field and Serialization Changes

```ts
// Existing unversioned inspection.
const inspected = monitor.getInspectedSnapshot();
const pendingAgeMs: bigint = inspected.oldestPendingAgeMs;

// Preferred versioned operator contract.
const operator = monitor.getOperatorSnapshot();
const pendingAgeDecimal: string = operator.backlog.oldestAgeMs;
const serialized = JSON.stringify(operator);
```

All millisecond and byte quantities are decimal strings. This preserves full precision through `JSON.stringify()` without a BigInt replacer. Convert an individual value with `BigInt(value)` only when local arithmetic is needed.

For a captured raw `MonitorSnapshot`, use `inspectMonitorSnapshotV1(raw, storage)` instead of `inspectMonitorSnapshot(raw)`. Version 1 groups evidence under `admission`, `backlog`, `replay`, and `storage`. Follow these public fields instead of translating internal counters or human-readable reason text.

The snapshot exposes stable overall status, affected components, recommended action, admission posture, backlog age, replay progress, and bounded filesystem facts. Storage pressure is `critical` at 5% or less available, `elevated` above 5% through 15%, and `normal` above 15%. In-memory reservoirs and unavailable metadata report `unknown`; snapshot creation does not run an integrity check or ingress table scan.

During replay failure, an active retry deadline reports `status: "recovering"` and `recommendedAction: "wait_for_retry"`. After the deadline passes, it reports `status: "attention_required"` and `recommendedAction: "inspect_replay_failure"`; the recovery gate remains closed and admission remains accepted-buffered until replay resumes or the backlog is reconciled.

See the [operator runbook](../operator-runbook.md) for interpreting these states.

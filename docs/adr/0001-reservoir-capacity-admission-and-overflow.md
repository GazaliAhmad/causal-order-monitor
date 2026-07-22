# ADR 0001: Reservoir Capacity, Admission, and Overflow Semantics

- Status: Accepted
- Date: 2026-07-16
- Target implementation: `v0.5.0`
- Public-semantics freeze: `v0.6.0`

Scheduling addendum (2026-07-22): the original freeze assignment above is retained as the accepted ADR's historical plan. The published `v0.6.0` release was reassigned to transport `0.2.0` compatibility and acknowledged-delivery qualification; the broader API and semantic freeze is now assigned to `v0.7.0` in `ROADMAP.md`.

## Context

The monitor currently bounds pending work by retention age, not by row count, logical payload bytes, database bytes, or filesystem reserve. Retention and capacity answer different questions: a four-hour window limits age only after pruning runs, while a sudden ingress spike can exhaust storage well before four hours.

Capacity behavior is part of the durability contract. Once the monitor reports an event as accepted, operators and upstream systems need to know whether capacity pressure may later discard it. A quota is therefore not merely a configuration convenience; it defines admission, overload, recovery, and data-loss semantics.

SQLite makes a single physical `maxBytes` promise misleading:

- deleted pages can remain in the database for reuse;
- the WAL changes size independently from the main database;
- indexes, tables, journaling, and SQLite metadata add overhead beyond payload bytes;
- health and replay history can grow independently from pending ingress;
- other processes can consume filesystem capacity after it is inspected;
- filesystem metadata may be unavailable or stale; and
- `SQLITE_FULL` can still occur after a preventive capacity check.

This ADR defines the accepted capacity model that governs implementation.

## Decision drivers

- Never report rejected work as accepted.
- Do not silently sacrifice previously accepted pending work to admit newer work.
- Make overload predictable before the filesystem reaches zero available bytes.
- Keep quota decisions deterministic, transactional, restart-safe, and observable.
- Avoid claiming an exact physical byte bound that SQLite and the host filesystem cannot guarantee.
- Preserve upstream retry and the monitor's at-least-once-until-acknowledgement-or-retention-expiry contract.
- Keep host provisioning, volume alerts, backup capacity, and disaster recovery as explicit deployment responsibilities.

## Decision

Use layered capacity controls rather than one physical `maxBytes` setting:

```text
serialized-event payload limit
              +
pending-row limit
              +
logical pending-payload byte limit
              +
filesystem reserve guard
              +
SQLITE_FULL fail-closed fallback
              +
deployment-owned disk monitoring
```

The initial and only required overflow behavior is `reject_new`. The monitor does not automatically dead-letter or delete an accepted pending row to create room for newer ingress.

### Capacity dimensions

#### Maximum serialized event bytes

`maxPayloadBytes` limits the UTF-8 byte length of the complete serialized ingress event stored in `payload_json`, not the in-memory object size. Serialization occurs before admission. Serialization failure or a payload above the limit is a definite pre-acceptance rejection.

The name may be refined before the `v0.6.0` freeze to make clear that the stored object is the complete event envelope rather than only `event.payload`.

#### Maximum pending rows

`maxPendingRows` limits rows in `pending` or `replaying` state. A normal live event counts after persistence and stops counting only when its delivered transition commits. Retry-waiting and actively replaying rows remain pending capacity.

Delivered and dead-letter rows do not consume pending-row quota, although they continue to consume physical storage until terminal retention deletes them.

#### Maximum logical pending bytes

`maxPendingPayloadBytes` limits the sum of stored serialized-event bytes for rows in `pending` or `replaying` state. The measurement excludes SQLite page, index, WAL, and filesystem overhead and must be documented as a logical backlog limit, not a physical database-size limit.

The append check, row insert, and logical-capacity accounting must commit atomically. Delivery, dead-letter, deletion, retry, and replay transitions must update or preserve accounting consistently. Restart and schema migration must reconstruct or validate accounting without relying on stale process memory.

Implementation may require a schema migration to store per-row serialized bytes and transactional aggregate state. A full-table sum on every ingress and an unprotected check-then-append sequence are not acceptable hot-path or concurrency designs.

#### Filesystem reserve

A configurable filesystem reserve guard prevents admission when observed available space is at or below the configured floor. Filesystem evidence is advisory and race-prone rather than an exact transaction invariant, but it provides earlier protection than waiting for `SQLITE_FULL`.

The guard must include a configurable recovery margin or equivalent hysteresis so admission does not flap at one exact threshold. The behavior when filesystem evidence is `unknown` must be explicit and configurable:

- compatibility posture: allow logical-quota admission while reporting unknown evidence;
- conservative posture: refuse admission until capacity evidence becomes available.

The long-term default is finalized during `v0.6.0` API and semantic freeze.

#### Physical database and WAL bytes

Database and WAL byte sizes remain observed operational facts. They are not presented as a strict `maxBytes` invariant in the initial capacity API. If a later implementation proposes a physical SQLite page limit, it requires a follow-up ADR covering WAL behavior, reusable pages, checkpoints, migrations, terminal/history tables, and emergency operational recovery.

## Admission and durability semantics

Capacity refusal occurs before an ingress row commits. It is a protective refusal, not accepted buffering:

```text
serialize and measure event
          ↓
begin capacity-aware append transaction
          ↓
validate enforceable logical quotas
          ↓
append row and update accounting
          ↓
commit = accepted
```

If quota validation or append fails, no row is accepted and upstream must retain/retry the event according to its policy. Capacity refusal maps to protective HTTP `503`, consistent with temporary monitor inability to accept work; it does not map to `202` or ordinary buffered acceptance.

Stable capacity error and admission reason codes are added with the implementation and frozen in `v0.6.0`. They must distinguish configured quota refusal from SQLite full/read-only/I/O failures while preserving the common fact that no row was accepted.

The durable promise is:

> Capacity pressure refuses new work before acceptance. It does not silently evict previously accepted pending work. Accepted rows remain eligible until acknowledgement, an explicit operator/application transition, or the documented retention boundary.

Retention expiry remains a separate, already documented terminal transition. Capacity configuration must not silently shorten retention.

## Overflow policies

### Supported initially: `reject_new`

Reject before persistence with stable evidence. This is deterministic, preserves previously accepted work, and gives upstream a clear retry boundary.

### Not supported initially: `dead_letter_oldest_pending`

This policy discards previously accepted work because newer work arrived. It changes the durability guarantee and can break causal or entity history. It must not be the default and requires a separate ADR before it can become supported.

### Not distinct initially: `pause_ingress`

At the monitor boundary, pausing ingress is represented by protective refusal until capacity returns. A scheduler or transport can use the refusal evidence to stop polling or slow producers, but the monitor cannot keep an unpersisted event safely on behalf of upstream.

### Deployment-controlled actions

Operators may expand storage, restore downstream service, accelerate safe replay, run supported pruning, or stop ingress externally. Manual deletion or mutation of pending SQLite rows is not a supported overflow mechanism.

## Observability

Capacity inspection must expose, without requiring consumers to infer semantics:

- configured row, logical-byte, per-event, and filesystem-reserve limits;
- current pending rows and logical pending bytes;
- utilization for enforceable logical quotas;
- database bytes, WAL bytes, filesystem available/total bytes, and evidence status;
- active capacity posture and the specific limiting dimension;
- cumulative process-level quota refusals and storage append failures through lifecycle observations; and
- stable operator action and admission reason codes.

Physical filesystem percentage and logical quota percentage must remain separate fields. Neither is a substitute for the other.

## Auxiliary-table growth

Pending quotas do not bound `component_health_log`, `replay_sessions`, delivered evidence, or dead-letter evidence. Before the package claims a physically bounded storage envelope, every append-only or terminal data class needs an explicit retention/compaction policy and corresponding operational evidence.

The `v0.5.0` implementation must document this distinction. Auxiliary retention may be implemented in the same phase or scheduled through a follow-up ADR, but it cannot be hidden behind the pending-backlog quota.

## Failure behavior

- `SQLITE_FULL`, read-only, I/O, and WAL-sidecar failures remain definite append failures even when preventive limits are configured.
- A stale filesystem observation cannot turn a failed SQLite append into accepted work.
- Failed quota/accounting transactions roll back both the row and accounting state.
- Restart validates capacity accounting before reopening admission.
- Migration failure rolls back and leaves the previous supported schema authoritative.
- Pruning a pending row to `dead_letter` releases logical pending quota only after the transition commits; it may not release physical file bytes.
- Marking a row delivered releases logical pending quota only after acknowledgement commits.
- Replay claiming does not release pending quota.
- Backup, checkpoint, and migration operations can require temporary free space beyond logical limits and remain covered by operational procedures.

## Ordering and causal consequences

Quota refusal rejects the new event presented at the boundary. It does not choose an older accepted event to discard. Upstream retry can therefore delay a later event while earlier accepted events drain, which is safer than silently creating a hole in accepted causal history.

The monitor does not promise fairness among independent producers. If fairness, tenant reservation, or priority admission is required, it needs a separate policy and ADR because it changes which events receive durable acceptance under contention.

## Alternatives considered

### Retention-only management

Rejected because age does not bound burst capacity and pruning is host-driven.

### Row limit only

Rejected as the complete solution because event sizes vary substantially. Retained as one useful layer.

### Logical byte limit only

Rejected as the complete solution because many small rows have per-row/index overhead and physical storage can be consumed by terminal/history data. Retained as one enforceable layer.

### Physical database/WAL `maxBytes`

Deferred because it is difficult to define truthfully across reusable pages, WAL lifecycle, temporary migration/checkpoint space, auxiliary tables, and filesystem races.

### Filesystem reserve only

Rejected as the complete solution because evidence can be unavailable or stale and the filesystem is shared with unrelated consumers. Retained as a protective layer.

### Evict oldest accepted pending work

Rejected because it weakens durable acceptance and may create causal-history gaps.

### Deployment quotas only

Rejected as the package's only defense because filesystem exhaustion is a late, coarse failure boundary. Host quotas and alerts remain required in addition to package-level logical admission limits.

## Consequences

### Positive

- Overload becomes predictable before storage exhaustion.
- Previously accepted pending work is not sacrificed for newer ingress.
- Operators can distinguish logical quota pressure from physical disk pressure.
- Upstream receives a stable retryable refusal instead of ambiguous acceptance.
- Capacity semantics become testable across concurrency, crash, restart, and migration boundaries.

### Negative

- Capacity-aware append and state transitions become more complex.
- Exact logical accounting likely requires schema evolution and additional transactional writes.
- Preventive guards cannot eliminate `SQLITE_FULL` or replace host monitoring.
- Conservative filesystem-evidence policy can reduce availability when metadata is unavailable.
- There is no universal safe default limit; deployment sizing remains necessary.

## Required validation

Before `v0.5.0` is complete, tests must cover:

- exact and adjacent boundaries for every configured limit;
- serialized UTF-8 byte measurement, including BigInt encoding and Unicode;
- rejection-before-acceptance and stable HTTP/error/reason semantics;
- concurrent ingress at the last available row/byte unit;
- acknowledgement, retry, replay, dead-letter, and deletion accounting transitions;
- crash before and after capacity-aware append and accounting commits;
- restart accounting reconstruction and mismatch detection;
- schema migration with pending, replaying, delivered, and dead-letter rows;
- filesystem reserve thresholds, hysteresis, and unavailable evidence policy;
- genuine `SQLITE_FULL` despite configured preventive limits;
- sustained-load refusal without unbounded memory or database growth; and
- proof that quota pressure never silently evicts an accepted pending row.

## Release and compatibility plan

- `v0.4.0`: reference integration preserves current capacity behavior and supplies evidence needed to validate the accepted design.
- `v0.5.0`: implement and qualify opt-in capacity controls under this accepted ADR.
- `v0.6.0`: freeze configuration names/defaults, admission/error/reason semantics, operator fields, accounting definitions, and compatibility rules.
- `v1.0.0`: publish no stronger physical-bound claim than the implementation and validation evidence support.

The release list above is the ADR's original sequencing record. The 2026-07-22 scheduling addendum moves its `v0.6.0` freeze item to `v0.7.0` without deleting or rewriting the progression that led to the revised roadmap.

## Follow-up decisions

Separate ADRs are required before adding:

- eviction of accepted pending work;
- tenant-, producer-, or priority-aware admission;
- a hard physical SQLite page/file limit;
- a durable telemetry/audit outbox; or
- shared multi-process reservoir ownership.

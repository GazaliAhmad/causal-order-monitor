# Persistence Operations

This guide covers the supported SQLite lifecycle for `@causal-order/monitor`. The live database must be on a writable, host-local filesystem owned by one monitor process.

## Retention and cleanup

Delivered and dead-letter evidence use independent clocks and policies:

- `reservoir.deliveredRetentionMs` defaults to `24h`
- `reservoir.deadLetterRetentionMs` defaults to `168h` (7 days)
- `reservoir.pruneBatchSize` bounds both state transitions and row deletions in each prune call

Repeated prune calls drain larger eligible sets. A row newly moved to `dead_letter` starts its dead-letter retention clock at that transition and is not removed under the delivered policy.

## WAL lifecycle

File-backed reservoirs use WAL journaling and `synchronous=FULL`. `reservoir.walAutoCheckpointPages` defaults to 1000 pages; set it to `0` only when explicit operator-managed checkpoints replace automatic checkpointing.

`SQLiteReservoir.checkpointWal()` exposes `passive`, `restart`, and `truncate` modes and returns whether the checkpoint was busy plus its log and checkpointed frame counts. Routine inspection should use `passive`. Use `truncate` only during a controlled maintenance or backup window because it can wait on active readers. Closing a reservoir performs a passive checkpoint; crash cleanup must not depend on close running.

## Storage failure handling

The monitor does not hide SQLite storage failures or convert a rejected write into an accepted event. Operators should correct the underlying storage condition before retrying or restarting repeatedly.

`classifyMonitorBoundaryFailure()` maps recognized contention, full-storage, read-only, and I/O failures to stable codes without making SQLite message text contractual. `MonitorClosedError` identifies definite post-close rejection. `MonitorIndeterminateOutcomeError` means a row was already persisted but later adapter delivery or acknowledgement did not complete observably; reconcile the row from monitor storage instead of blindly retrying or assuming delivery.

`getOperatorSnapshot().storage` uses bounded file and filesystem metadata reads. It does not run `PRAGMA integrity_check` or scan ingress rows. Available capacity of 5% or less is classified `critical`; 15% or less is `elevated`; more is `normal`. In-memory databases and unavailable metadata report `unknown`. These levels are package operational signals, not substitutes for deployment-specific volume alerts.

This is the current `v0.3.3` contract; it does not enforce a row, logical-byte, or filesystem-reserve admission quota. Future `v0.5.0` capacity work is governed by [ADR 0001](adr/0001-reservoir-capacity-admission-and-overflow.md), which keeps logical quotas distinct from physical database/WAL observations and host-level disk monitoring.

### Busy and locked databases

The supported ownership model remains one monitor writer process. If another SQLite connection holds a conflicting write transaction, append, replay transition, acknowledgement, and prune writes fail without committing a partial transition. Release the unexpected writer or transaction before retrying.

WAL checkpoints report contention through `WalCheckpointResult.busy`. A busy `restart` or `truncate` checkpoint is not successful maintenance completion; allow active readers/writers to settle and retry in a controlled window.

### Read-only paths and exhausted storage

The database and its parent directory must remain writable so SQLite can update the primary file and create or update `-wal` and `-shm` sidecars. A read-only SQLite connection rejects mutation while preserving existing rows. Filesystem enforcement varies by operating system and process privileges, so deployment validation must exercise the actual service account and mount.

If SQLite reports that the database or disk is full, the rejected statement does not count as accepted monitor ingress. Free or expand storage, preserve the database and sidecars, then reopen and inspect schema and reservoir state before resuming ingress. Do not delete WAL files to reclaim emergency space while a database may be live.

### WAL I/O failure

Failure to create or use the WAL sidecar may surface during startup or the first write. Stop the restart loop, preserve the primary database and any existing sidecars, and correct the directory, file-type, permission, or capacity problem. After correction, reopen normally and verify schema and row counts. Do not replace, truncate, or manually synthesize a WAL sidecar.

### Corrupt or incompatible files

Non-database, truncated, and structurally incompatible files fail closed. The monitor does not silently replace them or attempt automatic repair. Preserve the original files, stop writers, and recover from a verified backup or use qualified SQLite recovery tooling on a copy. Never run repair attempts against the only copy of accepted-event evidence.

## Payload serialization and sizing

Ingress events are stored as JSON with monitor-managed BigInt encoding. Ordinary objects, arrays, strings, numbers, booleans, nulls, Unicode, and BigInt values round-trip. Literal application objects whose keys resemble the internal BigInt encoding are escaped and restored rather than converted accidentally.

Standard JSON transformations still apply: undefined object properties, functions, and symbols are omitted; undefined array entries become null; and non-finite numbers become null. Cyclic values and values too deeply nested for JSON serialization are rejected before the reservoir records acceptance.

Repository validation covers representative payload bodies of 1 KiB, 64 KiB, and 1 MiB. These are compatibility examples, not a universal maximum or throughput guarantee. Set an application-owned payload limit based on outage duration, ingress rate, storage capacity, replay rate, and measured deployment behavior.

Payloads are stored in the primary SQLite database and may also appear in WAL pages and backups. The monitor does not encrypt or redact application payloads. Applications and operators remain responsible for excluding secrets that should not be persisted and for applying appropriate filesystem, backup, and volume encryption controls.

## Shutdown lifecycle

`SQLiteReservoir.close()`, `MonitorRuntime.close()`, and `TransportMonitorAdapter.close()` are idempotent. Repeated close calls are safe and do not reopen or re-checkpoint a closed database.

Once runtime shutdown begins, new ingress, health mutation, replay control, pruning, checkpointing, and database-backed inspection are rejected consistently. Cached configuration, schema identity, component-health evidence, replay evidence, recovery flags, reservoir path, and final in-memory pending count remain readable through the surfaces that already own those values. Treat cached post-close values as final local evidence, not as a live database inspection.

If close overlaps an asynchronous delivery handler, the event may already be accepted in SQLite even though the in-flight adapter promise later rejects when it attempts acknowledgement. On restart, an unacknowledged ingress row remains pending, and an interrupted replay claim is reclaimed through normal restart recovery. Do not delete or re-create the database in response to the rejected promise; reopen and reconcile persisted state.

Close still attempts a passive checkpoint, but crash correctness does not depend on that checkpoint. If the checkpoint reports an I/O error, close attempts to release the SQLite connection and surfaces the checkpoint error. Correct the storage condition and inspect the database before resuming service.

## Backup

The supported file-copy procedure is stopped and checkpointed:

1. Stop ingress and replay for the owning monitor process.
2. Call `checkpointWal("truncate")` and require `busy: false`.
3. Close the runtime or reservoir.
4. Copy the primary `.sqlite` file and preserve its filesystem permissions.
5. Keep the original until the copied database has reopened and passed schema inspection.

Do not copy only the primary file while the process is live. A live WAL database may have committed data in `-wal`, and `-shm` coordinates active connections. If an external snapshot system captures a live database, it must atomically capture the database, `-wal`, and `-shm` files together and must be validated independently; that is not the package-supported file-copy procedure.

## Restore and relocation

Restore or relocate only while no monitor process owns either path:

1. Place the checkpointed database on a writable host-local filesystem.
2. Do not carry stale `-wal` or `-shm` files from another database generation.
3. Configure `reservoir.databasePath` to the restored location.
4. Start one monitor process and call `getSchemaInfo()`.
5. Confirm the expected schema version and inspect pending, delivered, and dead-letter counts before reopening ingress.

Opening a supported older schema runs its migration transactionally. Opening a newer or structurally incompatible schema fails closed.

## Migration failure recovery and rollback

On migration failure, leave the database files in place and stop restart loops. Preserve a full copy before correcting the reported filesystem, schema, or conflicting-object condition. Reopen with the same or newer package after correction; migrations are transactional and retryable.

The package does not provide downgrade migrations. Rolling application code back after schema version 2 is created requires a release that supports schema version 2. Restore a verified pre-upgrade backup only if discarding all events accepted after that backup is operationally acceptable.

## Growth and compaction

Retention deletes logical rows but SQLite may retain pages for reuse, so physical file size need not fall immediately. Track row counts, database size, WAL size, and checkpoint results over representative ingest/prune cycles in the deployment environment.

`VACUUM` is a maintenance-only operation. Run it only against a stopped, backed-up database with sufficient free disk space; it is intentionally not part of the live monitor path.

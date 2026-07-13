# Persistence Operations

This guide covers the supported SQLite lifecycle for `@causal-order/monitor` v0.2.2. The live database must be on a writable, host-local filesystem owned by one monitor process.

## Retention and cleanup

Delivered and dead-letter evidence use independent clocks and policies:

- `reservoir.deliveredRetentionMs` defaults to `24h`
- `reservoir.deadLetterRetentionMs` defaults to `168h` (7 days)
- `reservoir.pruneBatchSize` bounds both state transitions and row deletions in each prune call

Repeated prune calls drain larger eligible sets. A row newly moved to `dead_letter` starts its dead-letter retention clock at that transition and is not removed under the delivered policy.

## WAL lifecycle

File-backed reservoirs use WAL journaling and `synchronous=FULL`. `reservoir.walAutoCheckpointPages` defaults to 1000 pages; set it to `0` only when explicit operator-managed checkpoints replace automatic checkpointing.

`SQLiteReservoir.checkpointWal()` exposes `passive`, `restart`, and `truncate` modes and returns whether the checkpoint was busy plus its log and checkpointed frame counts. Routine inspection should use `passive`. Use `truncate` only during a controlled maintenance or backup window because it can wait on active readers. Closing a reservoir performs a passive checkpoint; crash cleanup must not depend on close running.

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

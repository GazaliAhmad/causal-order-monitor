# Schema Compatibility

SQLite schema compatibility is an explicit contract, independent from the npm package version. Updating the package does not imply a database migration unless the schema version changes.

## Current Contract

The current reservoir schema is version 2. New reservoirs record their version during transactional initialization. `SQLiteReservoir.getSchemaInfo()` and `MonitorRuntime.getSchemaInfo()` expose the current and latest supported versions; constants, information types, and typed compatibility errors are published from `@causal-order/monitor/storage`.

- Compatible unversioned reservoirs migrate transactionally without discarding rows.
- Current reservoirs reopen without schema mutation.
- Newer, incomplete, or structurally incompatible schemas fail before mutation.
- File-backed reservoirs use WAL journaling with `synchronous=FULL`.
- Close is idempotent, mutable work after close is rejected, and accepted rows remain recoverable when shutdown overlaps delivery.

Schema version 2 adds `terminal_at_ms` so terminal evidence retention begins at delivery or dead-letter transition. Existing terminal rows receive their original monitor-ingest time during migration; new transitions record the actual transition time.

## Version History

- Package `v0.2.0` established schema version 1 as an explicit persistence contract.
- Package `v0.2.1` added deterministic restart and upgrade recovery.
- Package `v0.2.2` migrated the reservoir to schema version 2 for terminal-evidence retention.
- Package `v0.2.3` retained schema version 2 while hardening crash, storage-failure, concurrency, serialization, and shutdown behavior.

## Restart Reconstruction

Persisted row state is authoritative after restart:

- Pending backlog restores a queued replay posture and keeps live flow gated.
- Interrupted `replaying` claims immediately return to `pending` because their in-memory owner ended.
- An entirely retry-waiting backlog restores its failed posture from the persisted absolute retry deadline and replay-attempt evidence.
- Delivered and dead-letter rows remain terminal and do not return to replay eligibility.
- Replay ordering continues to use monitor ingest time and row identity.
- Persisted `replay_sessions` remain audit history and do not override current row state during reconstruction.

## Failure and Rollback

Migrations are transactional and retryable. On failure, preserve the files, stop restart loops, correct the reported storage or schema condition, and reopen with the same or a newer compatible package.

The package does not provide downgrade migrations. Rolling back code after schema version 2 is created requires a release that supports schema version 2. Restoring a pre-upgrade backup discards every event accepted after that backup and must be an explicit operational decision.

See [persistence operations](persistence-operations.md) for backup and restore procedures and [release history](../CHANGELOG.md) for package changes.

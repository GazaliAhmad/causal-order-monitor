import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDefaultMonitorConfig } from "../.build/src/index.js";
import {
  MONITOR_SQLITE_SCHEMA_VERSION,
  MonitorCapacityAccountingError,
  MonitorSchemaMigrationError,
  SQLiteReservoir,
} from "../.build/src/storage.js";

const legacySchema = readFileSync(
  new URL("./fixtures/legacy-monitor-schema-v0.sql", import.meta.url),
  "utf8",
);
const workspace = mkdtempSync(join(tmpdir(), "monitor-capacity-accounting-"));

function reservoirConfig(databasePath) {
  return { ...createDefaultMonitorConfig().reservoir, databasePath };
}

function event(id, payload = { fixture: "capacity-accounting" }) {
  return {
    id,
    nodeId: "capacity-node",
    clock: { physicalTimeMs: 1_000n },
    payload,
    ingestedAt: 1_000n,
  };
}

function append(reservoir, id, replayState = "pending", payload) {
  return reservoir.appendIngressEvent(event(id, payload), {
    sourcePath: "transport_normalized_stream",
    deliveryMode: "order_buffer_only",
    replayState,
  });
}

function inspect(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const state = db.prepare(
      `SELECT pending_rows, pending_serialized_bytes
         FROM reservoir_capacity_state
        WHERE singleton_id = 1`,
    );
    state.setReadBigInts(true);
    const accounting = state.get();
    const rows = db.prepare(
      `SELECT rowid AS row_id, replay_state, payload_json, serialized_event_bytes
         FROM ingress_events
        ORDER BY rowid`,
    );
    rows.setReadBigInts(true);
    return { accounting, rows: rows.all() };
  } finally {
    db.close();
  }
}

function expectedUsage(rows) {
  const pending = rows.filter((row) =>
    row.replay_state === "pending" || row.replay_state === "replaying");
  return {
    pendingRows: BigInt(pending.length),
    pendingBytes: pending.reduce(
      (total, row) => total + BigInt(Buffer.byteLength(row.payload_json, "utf8")),
      0n,
    ),
  };
}

function assertAccounting(databasePath) {
  const snapshot = inspect(databasePath);
  const expected = expectedUsage(snapshot.rows);
  assert.equal(snapshot.accounting.pending_rows, expected.pendingRows);
  assert.equal(snapshot.accounting.pending_serialized_bytes, expected.pendingBytes);
  for (const row of snapshot.rows) {
    assert.equal(
      row.serialized_event_bytes,
      BigInt(Buffer.byteLength(row.payload_json, "utf8")),
    );
  }
  return snapshot;
}

function createSchemaV2Database(databasePath, { conflict = false } = {}) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(legacySchema);
    db.exec("ALTER TABLE ingress_events ADD COLUMN retry_not_before_ms INTEGER");
    db.exec("ALTER TABLE ingress_events ADD COLUMN replay_claimed_at_ms INTEGER");
    db.exec("ALTER TABLE ingress_events ADD COLUMN terminal_at_ms INTEGER");
    db.exec(`CREATE INDEX idx_ingress_events_replay_retry
      ON ingress_events(replay_state, retry_not_before_ms)`);
    db.exec(`CREATE INDEX idx_ingress_events_replay_claimed
      ON ingress_events(replay_state, replay_claimed_at_ms)`);
    db.exec(`CREATE INDEX idx_ingress_events_terminal_retention
      ON ingress_events(replay_state, terminal_at_ms)`);
    const insert = db.prepare(
      `INSERT INTO ingress_events (
        id, monitor_ingest_at_ms, source_node_id, source_stream_id, source_path,
        event_id, trace_id, sequence, logical_time_ms, payload_json,
        payload_encoding, delivery_mode, replay_state, replay_attempts,
        retry_not_before_ms, replay_claimed_at_ms, terminal_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fixtures = [
      ["pending", JSON.stringify({ value: "plain" })],
      ["replaying", JSON.stringify({ value: "多字节🙂" })],
      ["delivered", JSON.stringify({ value: "delivered" })],
      ["dead_letter", JSON.stringify({ value: "dead" })],
    ];
    for (const [index, [state, payloadJson]] of fixtures.entries()) {
      insert.run(
        `v2-${state}`,
        1_000 + index,
        "v2-node",
        "v2-stream",
        "transport_normalized_stream",
        `v2-${state}`,
        null,
        String(index + 1),
        1_000 + index,
        payloadJson,
        "json",
        "order_buffer_only",
        state,
        index,
        state === "pending" ? 2_000 : null,
        state === "replaying" ? 1_500 : null,
        state === "delivered" || state === "dead_letter" ? 1_000 + index : null,
        100_000,
      );
    }
    if (conflict) {
      db.exec(`CREATE TRIGGER reject_serialized_byte_backfill
        BEFORE UPDATE OF serialized_event_bytes ON ingress_events
        BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    }
    db.exec("PRAGMA user_version = 2");
  } finally {
    db.close();
  }
}

try {
  assert.equal(MONITOR_SQLITE_SCHEMA_VERSION, 3);

  const newPath = join(workspace, "new.sqlite");
  const fresh = new SQLiteReservoir(reservoirConfig(newPath), () => 10_000n);
  assert.deepEqual(fresh.getSchemaInfo(), {
    currentVersion: 3,
    latestSupportedVersion: 3,
    migratedFromLegacy: false,
  });
  fresh.close();
  let freshSnapshot = assertAccounting(newPath);
  assert.equal(freshSnapshot.rows.length, 0);

  const migrationPath = join(workspace, "migration.sqlite");
  createSchemaV2Database(migrationPath);
  const beforeMigration = new DatabaseSync(migrationPath, { readOnly: true });
  const payloadsBefore = beforeMigration.prepare(
    "SELECT payload_json FROM ingress_events ORDER BY rowid",
  ).all().map((row) => row.payload_json);
  beforeMigration.close();
  const migrated = new SQLiteReservoir(reservoirConfig(migrationPath), () => 10_000n);
  assert.deepEqual(migrated.getSchemaInfo(), {
    currentVersion: 3,
    latestSupportedVersion: 3,
    migratedFromLegacy: false,
  });
  migrated.close();
  const migratedSnapshot = assertAccounting(migrationPath);
  assert.deepEqual(migratedSnapshot.rows.map((row) => row.payload_json), payloadsBefore);
  assert.equal(migratedSnapshot.accounting.pending_rows, 2n);

  const transitionPath = join(workspace, "transitions.sqlite");
  const transitions = new SQLiteReservoir(reservoirConfig(transitionPath), () => 20_000n);
  const pendingId = append(transitions, "pending", "pending", { text: "ascii" });
  const unicodeId = append(transitions, "unicode", "pending", { text: "多字节🙂" });
  const terminalId = append(transitions, "terminal", "delivered", { text: "done" });
  assert.equal(transitions.getPendingRowCount(), 2);
  assertAccounting(transitionPath);
  transitions.claimReplayBatch(1);
  assertAccounting(transitionPath);
  assert.equal(transitions.markIngressRowsDelivered([pendingId, pendingId]), 1);
  assertAccounting(transitionPath);
  assert.equal(transitions.markIngressRowsDelivered([pendingId]), 1);
  assertAccounting(transitionPath);
  assert.equal(transitions.resetReplayBatchToPending([pendingId, pendingId]), 1);
  assertAccounting(transitionPath);
  assert.equal(transitions.deadLetterReplayBatch([pendingId]), 1);
  assertAccounting(transitionPath);
  assert.equal(transitions.updateReplayState(["delivered"], "pending"), 1);
  assertAccounting(transitionPath);
  assert.equal(transitions.updateReplayState(["pending", "replaying"], "pending"), 2);
  assertAccounting(transitionPath);
  assert.equal(transitions.updateReplayState(["pending"], "dead_letter"), 2);
  assertAccounting(transitionPath);
  assert.ok(unicodeId > 0 && terminalId > 0);
  transitions.close();
  const reopened = new SQLiteReservoir(reservoirConfig(transitionPath), () => 20_001n);
  assert.equal(reopened.getPendingRowCount(), 0);
  reopened.close();

  const prunePath = join(workspace, "prune.sqlite");
  const pruneReservoir = new SQLiteReservoir(
    {
      ...reservoirConfig(prunePath),
      rollingBufferWindowMs: 10n,
      fullOutageMaxWindowMs: 20n,
    },
    () => 10_000n,
  );
  append(pruneReservoir, "expired-pending");
  assert.deepEqual(pruneReservoir.pruneExpired(), {
    markedDeadLetter: 1,
    deletedRows: 0,
  });
  assert.equal(pruneReservoir.getPendingRowCount(), 0);
  assertAccounting(prunePath);
  pruneReservoir.close();

  const rollbackPath = join(workspace, "rollback.sqlite");
  const rollbackSeed = new SQLiteReservoir(reservoirConfig(rollbackPath), () => 30_000n);
  const rollbackRowId = append(rollbackSeed, "rollback-row");
  rollbackSeed.close();
  const triggerDb = new DatabaseSync(rollbackPath);
  triggerDb.exec(`CREATE TRIGGER reject_capacity_update
    BEFORE UPDATE ON reservoir_capacity_state
    BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END`);
  triggerDb.close();
  const rollbackReservoir = new SQLiteReservoir(reservoirConfig(rollbackPath), () => 30_001n);
  assert.throws(
    () => rollbackReservoir.markIngressRowsDelivered([rollbackRowId]),
    /injected accounting failure/,
  );
  assert.equal(rollbackReservoir.getPendingRowCount(), 1);
  rollbackReservoir.close();
  assert.equal(assertAccounting(rollbackPath).rows[0].replay_state, "pending");

  const aggregateMismatchPath = join(workspace, "aggregate-mismatch.sqlite");
  const mismatchSeed = new SQLiteReservoir(
    reservoirConfig(aggregateMismatchPath),
    () => 40_000n,
  );
  append(mismatchSeed, "mismatch");
  mismatchSeed.close();
  const mismatchDb = new DatabaseSync(aggregateMismatchPath);
  mismatchDb.exec("UPDATE reservoir_capacity_state SET pending_rows = pending_rows + 1");
  mismatchDb.close();
  assert.throws(
    () => new SQLiteReservoir(reservoirConfig(aggregateMismatchPath), () => 40_001n),
    (error) =>
      error instanceof MonitorCapacityAccountingError &&
      error.code === "ERR_MONITOR_CAPACITY_ACCOUNTING",
  );

  const rowMismatchPath = join(workspace, "row-mismatch.sqlite");
  const rowMismatchSeed = new SQLiteReservoir(
    reservoirConfig(rowMismatchPath),
    () => 50_000n,
  );
  append(rowMismatchSeed, "row-mismatch");
  rowMismatchSeed.close();
  const rowMismatchDb = new DatabaseSync(rowMismatchPath);
  rowMismatchDb.exec("UPDATE ingress_events SET serialized_event_bytes = serialized_event_bytes + 1");
  rowMismatchDb.close();
  assert.throws(
    () => new SQLiteReservoir(reservoirConfig(rowMismatchPath), () => 50_001n),
    MonitorCapacityAccountingError,
  );

  const migrationRollbackPath = join(workspace, "migration-rollback.sqlite");
  createSchemaV2Database(migrationRollbackPath, { conflict: true });
  assert.throws(
    () => new SQLiteReservoir(reservoirConfig(migrationRollbackPath), () => 60_000n),
    MonitorSchemaMigrationError,
  );
  const migrationRollbackDb = new DatabaseSync(migrationRollbackPath, { readOnly: true });
  assert.equal(migrationRollbackDb.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(
    migrationRollbackDb.prepare("PRAGMA table_info(ingress_events)").all()
      .some((column) => column.name === "serialized_event_bytes"),
    false,
  );
  migrationRollbackDb.close();

  console.log(
    "capacity accounting contract passed: schema-v3 creation/migration, UTF-8 evidence, transactional transitions, rollback, restart validation, and migration rollback are protected",
  );
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

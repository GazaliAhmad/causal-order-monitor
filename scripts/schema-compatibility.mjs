import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createDefaultMonitorConfig,
  createMonitorRuntime,
} from "../.build/src/index.js";
import {
  MONITOR_SQLITE_SCHEMA_VERSION,
  MonitorSchemaCompatibilityError,
  MonitorSchemaMigrationError,
  MonitorSchemaVersionError,
  SQLiteReservoir,
} from "../.build/src/storage.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-schema-compatibility-"));
const legacySchemaSql = readFileSync(
  new URL("./fixtures/legacy-monitor-schema-v0.sql", import.meta.url),
  "utf8",
);

function createConfig(databasePath) {
  const defaults = createDefaultMonitorConfig();
  return {
    ...defaults.reservoir,
    databasePath,
  };
}

function readUserVersion(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return Number(db.prepare("PRAGMA user_version").get().user_version);
  } finally {
    db.close();
  }
}

function readJournalSettings(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return {
      journalMode: db.prepare("PRAGMA journal_mode").get().journal_mode,
      synchronous: Number(db.prepare("PRAGMA synchronous").get().synchronous),
    };
  } finally {
    db.close();
  }
}

function readColumnNames(databasePath, tableName) {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function createLegacyDatabase(databasePath, { conflict = false } = {}) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(legacySchemaSql);
    db.prepare(
      `INSERT INTO ingress_events (
        id,
        monitor_ingest_at_ms,
        source_node_id,
        source_stream_id,
        source_path,
        event_id,
        trace_id,
        sequence,
        logical_time_ms,
        payload_json,
        payload_encoding,
        delivery_mode,
        replay_state,
        replay_attempts,
        expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-row",
      1_000,
      "node-1",
      "stream-1",
      "transport_normalized_stream",
      "event-1",
      "trace-1",
      "1",
      1_000,
      JSON.stringify({ value: "preserved" }),
      "json",
      "order_buffer_only",
      "pending",
      2,
      9_000,
    );
    if (conflict) {
      db.exec(`CREATE TABLE idx_ingress_events_replay_retry (id INTEGER)`);
    }
  } finally {
    db.close();
  }
}

try {
  assert.equal(MONITOR_SQLITE_SCHEMA_VERSION, 1);

  const newDatabasePath = join(workspace, "new.sqlite");
  const newReservoir = new SQLiteReservoir(
    createConfig(newDatabasePath),
    () => 1_000n,
  );
  assert.deepEqual(newReservoir.getSchemaInfo(), {
    currentVersion: 1,
    latestSupportedVersion: 1,
    migratedFromLegacy: false,
  });
  newReservoir.close();
  assert.equal(readUserVersion(newDatabasePath), 1);
  assert.deepEqual(readJournalSettings(newDatabasePath), {
    journalMode: "wal",
    synchronous: 2,
  });

  const runtimeDatabasePath = join(workspace, "runtime.sqlite");
  const runtime = createMonitorRuntime({
    reservoir: { databasePath: runtimeDatabasePath },
  });
  assert.deepEqual(runtime.getSchemaInfo(), {
    currentVersion: 1,
    latestSupportedVersion: 1,
    migratedFromLegacy: false,
  });
  runtime.close();

  const legacyDatabasePath = join(workspace, "legacy.sqlite");
  createLegacyDatabase(legacyDatabasePath);
  const legacyReservoir = new SQLiteReservoir(
    createConfig(legacyDatabasePath),
    () => 1_000n,
  );
  assert.deepEqual(legacyReservoir.getSchemaInfo(), {
    currentVersion: 1,
    latestSupportedVersion: 1,
    migratedFromLegacy: true,
  });
  assert.equal(legacyReservoir.getStats().totalPendingRows, 1);
  assert.equal(legacyReservoir.getPendingRowCount(), 1);
  assert.equal(legacyReservoir.markIngressRowsDelivered([1]), 1);
  assert.equal(legacyReservoir.getPendingRowCount(), 0);
  assert.equal(legacyReservoir.resetReplayBatchToPending([1]), 1);
  assert.equal(legacyReservoir.getPendingRowCount(), 1);
  legacyReservoir.close();
  assert.equal(readUserVersion(legacyDatabasePath), 1);
  assert.ok(readColumnNames(legacyDatabasePath, "ingress_events").includes("retry_not_before_ms"));
  assert.ok(readColumnNames(legacyDatabasePath, "ingress_events").includes("replay_claimed_at_ms"));

  const reopenedLegacy = new SQLiteReservoir(
    createConfig(legacyDatabasePath),
    () => 1_000n,
  );
  assert.equal(reopenedLegacy.getSchemaInfo().migratedFromLegacy, false);
  assert.equal(reopenedLegacy.getStats().totalPendingRows, 1);
  reopenedLegacy.close();

  const unversionedCurrentPath = join(workspace, "unversioned-current.sqlite");
  createLegacyDatabase(unversionedCurrentPath);
  {
    const db = new DatabaseSync(unversionedCurrentPath);
    db.exec("ALTER TABLE ingress_events ADD COLUMN retry_not_before_ms INTEGER");
    db.exec("ALTER TABLE ingress_events ADD COLUMN replay_claimed_at_ms INTEGER");
    db.close();
  }
  const unversionedCurrent = new SQLiteReservoir(
    createConfig(unversionedCurrentPath),
    () => 1_000n,
  );
  assert.equal(unversionedCurrent.getSchemaInfo().migratedFromLegacy, true);
  assert.equal(unversionedCurrent.getStats().totalPendingRows, 1);
  unversionedCurrent.close();
  assert.equal(readUserVersion(unversionedCurrentPath), 1);

  const newerDatabasePath = join(workspace, "newer.sqlite");
  {
    const db = new DatabaseSync(newerDatabasePath);
    db.exec("PRAGMA user_version = 99");
    db.close();
  }
  assert.throws(
    () => new SQLiteReservoir(createConfig(newerDatabasePath), () => 0n),
    (error) => {
      assert.ok(error instanceof MonitorSchemaVersionError);
      assert.equal(error.code, "ERR_MONITOR_SCHEMA_NEWER_THAN_SUPPORTED");
      assert.equal(error.detectedVersion, 99);
      return true;
    },
  );
  assert.equal(readUserVersion(newerDatabasePath), 99);

  const unrelatedDatabasePath = join(workspace, "unrelated.sqlite");
  {
    const db = new DatabaseSync(unrelatedDatabasePath);
    db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    db.close();
  }
  assert.throws(
    () => new SQLiteReservoir(createConfig(unrelatedDatabasePath), () => 0n),
    (error) => {
      assert.ok(error instanceof MonitorSchemaCompatibilityError);
      assert.equal(error.code, "ERR_MONITOR_SCHEMA_INCOMPATIBLE");
      assert.match(error.message, /Missing required table/);
      return true;
    },
  );
  assert.equal(readUserVersion(unrelatedDatabasePath), 0);

  const incompleteCurrentPath = join(workspace, "incomplete-current.sqlite");
  {
    const db = new DatabaseSync(incompleteCurrentPath);
    db.exec("CREATE TABLE ingress_events (monitor_ingest_seq INTEGER PRIMARY KEY)");
    db.exec("PRAGMA user_version = 1");
    db.close();
  }
  assert.throws(
    () => new SQLiteReservoir(createConfig(incompleteCurrentPath), () => 0n),
    MonitorSchemaCompatibilityError,
  );
  assert.equal(readUserVersion(incompleteCurrentPath), 1);

  const rollbackDatabasePath = join(workspace, "rollback.sqlite");
  createLegacyDatabase(rollbackDatabasePath, { conflict: true });
  const beforeColumns = readColumnNames(rollbackDatabasePath, "ingress_events");
  assert.ok(!beforeColumns.includes("retry_not_before_ms"));
  assert.ok(!beforeColumns.includes("replay_claimed_at_ms"));
  assert.throws(
    () => new SQLiteReservoir(createConfig(rollbackDatabasePath), () => 0n),
    (error) => {
      assert.ok(error instanceof MonitorSchemaMigrationError);
      assert.equal(error.code, "ERR_MONITOR_SCHEMA_MIGRATION_FAILED");
      assert.equal(error.fromVersion, 0);
      assert.equal(error.toVersion, 1);
      return true;
    },
  );
  assert.equal(readUserVersion(rollbackDatabasePath), 0);
  assert.deepEqual(
    readColumnNames(rollbackDatabasePath, "ingress_events"),
    beforeColumns,
  );
  {
    const db = new DatabaseSync(rollbackDatabasePath);
    db.exec("DROP TABLE idx_ingress_events_replay_retry");
    db.close();
  }
  const retriedMigration = new SQLiteReservoir(
    createConfig(rollbackDatabasePath),
    () => 0n,
  );
  assert.equal(retriedMigration.getSchemaInfo().currentVersion, 1);
  assert.equal(retriedMigration.getStats().totalPendingRows, 1);
  retriedMigration.close();
  assert.equal(readUserVersion(rollbackDatabasePath), 1);

  console.log(
    "schema compatibility passed: new databases are versioned, legacy rows migrate transactionally, current schemas reopen idempotently, newer/incompatible schemas do not mutate data, and rolled-back migrations can be retried",
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

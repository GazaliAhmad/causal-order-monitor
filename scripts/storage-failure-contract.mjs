import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLiteReservoir } from "../.build/src/storage.js";

const root = mkdtempSync(join(tmpdir(), "monitor-storage-failure-"));
let eventCounter = 0;

function config(databasePath, overrides = {}) {
  return {
    databasePath,
    rollingBufferWindowMs: 100_000n,
    fullOutageMaxWindowMs: 200_000n,
    pruneIntervalMs: 1_000n,
    pruneBatchSize: 100,
    deliveredRetentionMs: 1_000n,
    deadLetterRetentionMs: 2_000n,
    ...overrides,
  };
}

function event(id, monitorIngestAt = 250_000n, payload = {}) {
  return {
    id,
    nodeId: "storage-failure-node",
    clock: { physicalTimeMs: monitorIngestAt },
    payload: { fixture: "storage-failure", id, ...payload },
    ingestedAt: monitorIngestAt,
  };
}

function append(reservoir, options = {}) {
  eventCounter += 1;
  const id = options.id ?? `storage-event-${eventCounter}`;
  const monitorIngestAt = options.monitorIngestAt ?? 250_000n;
  return reservoir.appendIngressEvent(
    event(id, monitorIngestAt, options.payload),
    {
      sourcePath: "transport_normalized_stream",
      deliveryMode: "order_buffer_only",
      monitorIngestAt,
      replayState: options.replayState ?? "pending",
    },
  );
}

function countRows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM ingress_events").get().count);
  } finally {
    db.close();
  }
}

function assertBusy(error) {
  assert.match(String(error), /busy|locked/i);
  return true;
}

function holdWriteLock(databasePath) {
  const blocker = new DatabaseSync(databasePath);
  blocker.exec("PRAGMA journal_mode = WAL");
  blocker.exec("BEGIN IMMEDIATE");
  return blocker;
}

function releaseWriteLock(blocker) {
  try {
    blocker.exec("ROLLBACK");
  } finally {
    blocker.close();
  }
}

function testBusyAppend() {
  const databasePath = join(root, "busy-append.sqlite");
  const reservoir = new SQLiteReservoir(config(databasePath), () => 300_000n);
  const blocker = holdWriteLock(databasePath);
  try {
    assert.throws(() => append(reservoir, { id: "busy-append" }), assertBusy);
    assert.equal(reservoir.getPendingRowCount(), 0);
  } finally {
    releaseWriteLock(blocker);
  }
  assert.equal(append(reservoir, { id: "after-busy-append" }), 1);
  assert.equal(reservoir.getPendingRowCount(), 1);
  reservoir.close();
  assert.equal(countRows(databasePath), 1);
}

function testBusyClaimAndAcknowledge() {
  const claimPath = join(root, "busy-claim.sqlite");
  const claimReservoir = new SQLiteReservoir(config(claimPath), () => 300_000n);
  append(claimReservoir, { id: "busy-claim" });
  const claimBlocker = holdWriteLock(claimPath);
  try {
    assert.throws(() => claimReservoir.claimReplayBatch(1), assertBusy);
    assert.equal(claimReservoir.getPendingRowCount(), 1);
  } finally {
    releaseWriteLock(claimBlocker);
  }
  const [claimed] = claimReservoir.claimReplayBatch(1);
  assert.equal(claimed.rowId, 1);
  assert.equal(claimed.replayAttempts, 1);
  claimReservoir.close();

  const acknowledgePath = join(root, "busy-acknowledge.sqlite");
  const acknowledgeReservoir = new SQLiteReservoir(
    config(acknowledgePath),
    () => 300_000n,
  );
  append(acknowledgeReservoir, { id: "busy-acknowledge" });
  acknowledgeReservoir.claimReplayBatch(1);
  const acknowledgeBlocker = holdWriteLock(acknowledgePath);
  try {
    assert.throws(
      () => acknowledgeReservoir.markReplayBatchDelivered([1]),
      assertBusy,
    );
    assert.equal(acknowledgeReservoir.getPendingRowCount(), 1);
  } finally {
    releaseWriteLock(acknowledgeBlocker);
  }
  assert.equal(acknowledgeReservoir.markReplayBatchDelivered([1]), 1);
  assert.deepEqual(acknowledgeReservoir.getLifecycleStats(), {
    deliveredRows: 1,
    deadLetterRows: 0,
  });
  acknowledgeReservoir.close();
}

function testBusyPruneAndCheckpoint() {
  const prunePath = join(root, "busy-prune.sqlite");
  const pruneReservoir = new SQLiteReservoir(config(prunePath), () => 300_000n);
  append(pruneReservoir, { id: "busy-prune", monitorIngestAt: 0n });
  const pruneBlocker = holdWriteLock(prunePath);
  try {
    assert.throws(() => pruneReservoir.pruneExpired(false), assertBusy);
    assert.equal(pruneReservoir.getPendingRowCount(), 1);
  } finally {
    releaseWriteLock(pruneBlocker);
  }
  assert.deepEqual(pruneReservoir.pruneExpired(false), {
    markedDeadLetter: 1,
    deletedRows: 0,
  });
  pruneReservoir.close();

  const checkpointPath = join(root, "busy-checkpoint.sqlite");
  const checkpointReservoir = new SQLiteReservoir(
    config(checkpointPath, { walAutoCheckpointPages: 0 }),
    () => 300_000n,
  );
  append(checkpointReservoir, { id: "busy-checkpoint" });
  const checkpointBlocker = holdWriteLock(checkpointPath);
  try {
    const result = checkpointReservoir.checkpointWal("truncate");
    assert.equal(result.mode, "truncate");
    assert.equal(result.busy, true);
  } finally {
    releaseWriteLock(checkpointBlocker);
  }
  const recovered = checkpointReservoir.checkpointWal("truncate");
  assert.equal(recovered.busy, false);
  assert.equal(recovered.logFrames, 0);
  checkpointReservoir.close();
}

function testPortableReadOnlyConnection() {
  const databasePath = join(root, "read-only.sqlite");
  const reservoir = new SQLiteReservoir(config(databasePath), () => 300_000n);
  append(reservoir, { id: "read-only-existing" });
  reservoir.close();

  const readOnly = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      Number(readOnly.prepare("SELECT COUNT(*) AS count FROM ingress_events").get().count),
      1,
    );
    assert.throws(
      () => readOnly.exec("DELETE FROM ingress_events"),
      /readonly|read-only/i,
    );
  } finally {
    readOnly.close();
  }
  assert.equal(countRows(databasePath), 1);
}

function probeFilesystemReadOnlyEnforcement() {
  const databasePath = join(root, "filesystem-read-only.sqlite");
  const reservoir = new SQLiteReservoir(config(databasePath), () => 300_000n);
  append(reservoir, { id: "filesystem-read-only-existing" });
  reservoir.close();

  const originalMode = statSync(databasePath).mode;
  chmodSync(databasePath, 0o444);
  let rejected = false;
  let probe;
  try {
    probe = new SQLiteReservoir(config(databasePath), () => 300_000n);
    try {
      append(probe, { id: "filesystem-read-only-probe" });
    } catch (error) {
      assert.match(String(error), /readonly|read-only|permission|access/i);
      rejected = true;
    }
  } catch (error) {
    assert.match(String(error), /writable|readonly|read-only|permission|access/i);
    rejected = true;
  } finally {
    try {
      probe?.close();
    } catch {
      // A permission failure may also prevent checkpoint-on-close.
    }
    chmodSync(databasePath, originalMode);
  }
  return rejected;
}

function testDatabaseFull() {
  const databasePath = join(root, "database-full.sqlite");
  const initial = new SQLiteReservoir(config(databasePath), () => 300_000n);
  initial.close();

  // SQLite's max_page_count is connection-local in this runtime. Use it on a
  // direct connection to prove a genuine SQLITE_FULL statement is atomic.
  const limiter = new DatabaseSync(databasePath);
  try {
    limiter.exec("CREATE TABLE full_probe (data BLOB NOT NULL)");
    const pageCount = Number(limiter.prepare("PRAGMA page_count").get().page_count);
    limiter.exec(`PRAGMA max_page_count = ${pageCount}`);
    assert.throws(
      () => limiter.exec("INSERT INTO full_probe (data) VALUES (zeroblob(2097152))"),
      /full/i,
    );
    assert.equal(Number(limiter.prepare("SELECT COUNT(*) AS count FROM full_probe").get().count), 0);
    limiter.exec(`PRAGMA max_page_count = ${pageCount + 1024}`);
    limiter.exec("INSERT INTO full_probe (data) VALUES (zeroblob(1))");
    assert.equal(Number(limiter.prepare("SELECT COUNT(*) AS count FROM full_probe").get().count), 1);
    limiter.exec("DROP TABLE full_probe");
    limiter.exec(`CREATE TRIGGER inject_database_full
      BEFORE INSERT ON ingress_events
      BEGIN
        SELECT RAISE(ABORT, 'database or disk is full');
      END`);
  } finally {
    limiter.close();
  }

  // Exercise the reservoir's existing rejection/counter path with a
  // deterministic full-equivalent trigger after proving real SQLITE_FULL.
  const limited = new SQLiteReservoir(config(databasePath), () => 300_000n);
  try {
    assert.throws(
      () => append(limited, { id: "database-full-injected" }),
      /full/i,
    );
    assert.equal(limited.getPendingRowCount(), 0);
  } finally {
    limited.close();
  }
  assert.equal(countRows(databasePath), 0);

  const injector = new DatabaseSync(databasePath);
  try {
    injector.exec("DROP TRIGGER inject_database_full");
  } finally {
    injector.close();
  }
  const recovered = new SQLiteReservoir(config(databasePath), () => 300_000n);
  assert.equal(append(recovered, { id: "after-database-full" }), 1);
  recovered.close();
  assert.equal(countRows(databasePath), 1);
}

function testWalSidecarFailure() {
  const databasePath = join(root, "wal-sidecar-failure.sqlite");
  const initial = new SQLiteReservoir(config(databasePath), () => 300_000n);
  initial.close();

  const walPath = `${databasePath}-wal`;
  mkdirSync(walPath);
  let failedAtStartup = false;
  let reservoir;
  try {
    try {
      reservoir = new SQLiteReservoir(config(databasePath), () => 300_000n);
    } catch (error) {
      assert.match(String(error), /I\/O|disk|writable|directory|wal/i);
      failedAtStartup = true;
    }
    if (!failedAtStartup) {
      assert.throws(
        () => append(reservoir, { id: "wal-sidecar-failure" }),
        /I\/O|disk|directory|wal/i,
      );
      assert.equal(reservoir.getPendingRowCount(), 0);
    }
  } finally {
    try {
      reservoir?.close();
    } catch (error) {
      assert.match(String(error), /I\/O|disk|directory|wal/i);
    }
    rmSync(walPath, { recursive: true, force: true });
  }
  assert.equal(countRows(databasePath), 0);

  const recovered = new SQLiteReservoir(config(databasePath), () => 300_000n);
  assert.equal(append(recovered, { id: "after-wal-sidecar-failure" }), 1);
  recovered.close();
  assert.equal(countRows(databasePath), 1);
}

function assertRejectedWithoutMainFileMutation(databasePath, expectedPattern) {
  const before = readFileSync(databasePath);
  assert.throws(
    () => new SQLiteReservoir(config(databasePath), () => 300_000n),
    expectedPattern,
  );
  assert.deepEqual(readFileSync(databasePath), before);
}

function testCorruptAndIncompatibleFiles() {
  const nonDatabasePath = join(root, "not-a-database.sqlite");
  writeFileSync(nonDatabasePath, Buffer.from("not a sqlite database\n", "utf8"));
  assertRejectedWithoutMainFileMutation(nonDatabasePath, /schema|database|file/i);

  const truncatedPath = join(root, "truncated.sqlite");
  const valid = new SQLiteReservoir(config(truncatedPath), () => 300_000n);
  append(valid, { id: "before-truncate" });
  valid.close();
  const validBytes = readFileSync(truncatedPath);
  writeFileSync(truncatedPath, validBytes.subarray(0, 100));
  assertRejectedWithoutMainFileMutation(truncatedPath, /schema|database|malformed|file/i);

  const incompatiblePath = join(root, "incompatible-schema.sqlite");
  const incompatible = new DatabaseSync(incompatiblePath);
  incompatible.exec("CREATE TABLE ingress_events (id TEXT PRIMARY KEY)");
  const originalSql = incompatible.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ingress_events'",
  ).get().sql;
  incompatible.close();
  assert.throws(
    () => new SQLiteReservoir(config(incompatiblePath), () => 300_000n),
    /schema|incompatible|missing/i,
  );
  const reopened = new DatabaseSync(incompatiblePath, { readOnly: true });
  try {
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(
      reopened.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ingress_events'",
      ).get().sql,
      originalSql,
    );
  } finally {
    reopened.close();
  }
}

try {
  testBusyAppend();
  testBusyClaimAndAcknowledge();
  testBusyPruneAndCheckpoint();
  testPortableReadOnlyConnection();
  const filesystemReadOnlyEnforced = probeFilesystemReadOnlyEnforcement();
  testDatabaseFull();
  testWalSidecarFailure();
  testCorruptAndIncompatibleFiles();

  console.log(
    "storage-failure contract passed: busy/locked writes roll back cleanly, WAL checkpoint contention is structured, WAL sidecar failure recovers, read-only SQLite rejects writes, SQLITE_FULL preserves acceptance state, and corrupt/incompatible files fail without main-file mutation",
  );
  console.log(
    filesystemReadOnlyEnforced
      ? "filesystem read-only probe: enforced by this environment"
      : "filesystem read-only probe: chmod is not enforced for this process; portable read-only SQLite coverage passed and filesystem/WAL permission injection remains environment-specific",
  );
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

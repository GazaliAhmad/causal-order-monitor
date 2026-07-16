import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultMonitorConfig } from "../.build/src/index.js";
import { SQLiteReservoir } from "../.build/src/storage.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-wal-lifecycle-"));
const databasePath = join(workspace, "monitor.sqlite");
const defaults = createDefaultMonitorConfig();
const reservoir = new SQLiteReservoir(
  { ...defaults.reservoir, databasePath, walAutoCheckpointPages: 25 },
  () => 1_000n,
);

try {
  const createdStorage = reservoir.getStorageSnapshot();
  assert.equal(createdStorage.pressure === "unknown", false);
  assert.ok(BigInt(createdStorage.databaseBytes) > 0n);
  assert.ok(BigInt(createdStorage.walBytes) >= 0n);
  assert.ok(BigInt(createdStorage.filesystemAvailableBytes) >= 0n);
  assert.ok(BigInt(createdStorage.filesystemTotalBytes) > 0n);
  assert.equal(typeof createdStorage.filesystemUsedPercent, "number");

  for (let i = 0; i < 200; i += 1) {
    reservoir.appendIngressEvent({
      id: `wal-${i}`,
      nodeId: "wal-node",
      clock: { physicalTimeMs: 1_000n, logicalCounter: 0n, nodeId: "wal-node" },
      payload: { entityId: `wal-${i}`, data: "x".repeat(256) },
    }, { sourcePath: "transport_normalized_stream", deliveryMode: "order_buffer_only" });
  }
  assert.ok(existsSync(`${databasePath}-wal`));
  assert.ok(statSync(`${databasePath}-wal`).size > 0);
  const writtenStorage = reservoir.getStorageSnapshot();
  assert.ok(BigInt(writtenStorage.databaseBytes) >= BigInt(createdStorage.databaseBytes));
  assert.equal(
    writtenStorage.walBytes,
    statSync(`${databasePath}-wal`, { bigint: true }).size.toString(),
  );
  const passive = reservoir.checkpointWal("passive");
  assert.equal(passive.mode, "passive");
  assert.equal(typeof passive.busy, "boolean");
  assert.ok(passive.logFrames >= passive.checkpointedFrames);
  const truncate = reservoir.checkpointWal("truncate");
  assert.deepEqual(truncate, {
    mode: "truncate",
    busy: false,
    logFrames: 0,
    checkpointedFrames: 0,
  });
  assert.equal(statSync(`${databasePath}-wal`).size, 0);
  const checkpointedStorage = reservoir.getStorageSnapshot();
  assert.equal(checkpointedStorage.walBytes, "0");
} finally {
  reservoir.close();
}

const reopened = new SQLiteReservoir(
  { ...defaults.reservoir, databasePath, walAutoCheckpointPages: 25 },
  () => 2_000n,
);
try {
  const reopenedStorage = reopened.getStorageSnapshot();
  assert.ok(BigInt(reopenedStorage.databaseBytes) > 0n);
  assert.ok(BigInt(reopenedStorage.walBytes) >= 0n);
  assert.equal(reopened.getPendingRowCount(), 200);
} finally {
  reopened.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log("WAL lifecycle contract passed: create, write, checkpoint, close, and reopen storage evidence is observable");

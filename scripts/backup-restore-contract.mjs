import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createDefaultMonitorConfig } from "../.build/src/index.js";
import { SQLiteReservoir } from "../.build/src/storage.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-backup-restore-"));
const sourcePath = join(workspace, "source", "monitor.sqlite");
const backupPath = join(workspace, "backup", "monitor.sqlite");
const relocatedPath = join(workspace, "relocated", "monitor.sqlite");
const defaults = createDefaultMonitorConfig();
const config = (databasePath) => ({ ...defaults.reservoir, databasePath });

try {
  const source = new SQLiteReservoir(config(sourcePath), () => 1_000n);
  source.appendIngressEvent({
    id: "preserved-event",
    nodeId: "backup-node",
    clock: { physicalTimeMs: 1_000n, logicalCounter: 0n, nodeId: "backup-node" },
    payload: { entityId: "preserved-event" },
  }, { sourcePath: "transport_normalized_stream", deliveryMode: "order_buffer_only" });
  assert.equal(source.checkpointWal("truncate").busy, false);
  source.close();

  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(sourcePath, backupPath);
  const restored = new SQLiteReservoir(config(backupPath), () => 1_000n);
  assert.equal(restored.getSchemaInfo().currentVersion, 2);
  assert.equal(restored.getStats().totalPendingRows, 1);
  restored.close();

  mkdirSync(dirname(relocatedPath), { recursive: true });
  renameSync(backupPath, relocatedPath);
  const relocated = new SQLiteReservoir(config(relocatedPath), () => 1_000n);
  assert.equal(relocated.getSchemaInfo().currentVersion, 2);
  assert.equal(relocated.getStats().totalPendingRows, 1);
  relocated.close();
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log("backup/restore contract passed: stopped checkpointed copies and relocation preserve schema v2 and accepted rows");

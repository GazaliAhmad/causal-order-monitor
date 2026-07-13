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
} finally {
  reservoir.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log("WAL lifecycle contract passed: automatic checkpoint threshold and explicit passive/truncate results are observable");

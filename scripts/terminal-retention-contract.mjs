import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultMonitorConfig } from "../.build/src/index.js";
import { SQLiteReservoir } from "../.build/src/storage.js";

function event(id, at) {
  return {
    id,
    nodeId: "retention-node",
    clock: { physicalTimeMs: at, logicalCounter: 0n, nodeId: "retention-node" },
    ingestedAt: at,
    payload: { entityId: id },
  };
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-terminal-retention-"));
let now = 0n;
const defaults = createDefaultMonitorConfig();
const reservoir = new SQLiteReservoir(
  {
    ...defaults.reservoir,
    databasePath: join(workspace, "monitor.sqlite"),
    rollingBufferWindowMs: 500n,
    fullOutageMaxWindowMs: 500n,
    deliveredRetentionMs: 1_000n,
    deadLetterRetentionMs: 2_000n,
    pruneBatchSize: 100,
  },
  () => now,
);

try {
  for (let i = 0; i < 250; i += 1) {
    reservoir.appendIngressEvent(event(`delivered-${i}`, 0n), {
      sourcePath: "deduped_observation",
      deliveryMode: "normal",
      replayState: "delivered",
    });
    const rowId = reservoir.appendIngressEvent(event(`pending-${i}`, 0n), {
      sourcePath: "transport_normalized_stream",
      deliveryMode: "order_buffer_only",
    });
    reservoir.deadLetterReplayBatch([rowId]);
  }

  assert.deepEqual(reservoir.getLifecycleStats(), {
    deliveredRows: 250,
    deadLetterRows: 250,
  });

  now = 1_001n;
  const first = reservoir.pruneExpired(false);
  assert.deepEqual(first, { markedDeadLetter: 0, deletedRows: 100 });
  assert.deepEqual(reservoir.getLifecycleStats(), {
    deliveredRows: 150,
    deadLetterRows: 250,
  });

  reservoir.pruneExpired(false);
  reservoir.pruneExpired(false);
  assert.deepEqual(reservoir.getLifecycleStats(), {
    deliveredRows: 0,
    deadLetterRows: 250,
  });

  now = 2_001n;
  assert.equal(reservoir.pruneExpired(false).deletedRows, 100);
  reservoir.pruneExpired(false);
  reservoir.pruneExpired(false);
  assert.deepEqual(reservoir.getLifecycleStats(), {
    deliveredRows: 0,
    deadLetterRows: 0,
  });
} finally {
  reservoir.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log("terminal retention contract passed: delivered and dead-letter clocks are independent and each prune call is batch-bounded");

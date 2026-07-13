import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteReservoir } from "../.build/src/storage.js";

function createEvent(id, ingestedAt) {
  return {
    id,
    nodeId: "edge-a",
    clock: {
      physicalTimeMs: ingestedAt,
      logicalCounter: 0n,
      nodeId: "edge-a",
    },
    sequence: 1n,
    traceId: `trace-${id}`,
    ingestedAt,
    payload: {
      traceId: `trace-${id}`,
      entityId: id,
      kind: "prune-batching",
    },
  };
}

function runExpiredPendingScenario() {
  const workspace = mkdtempSync(join(tmpdir(), "monitor-prune-batching-pending-"));
  const databasePath = join(workspace, "monitor.sqlite");
  const pruneBatchSize = 100;
  let nowMs = 0n;
  const reservoir = new SQLiteReservoir(
    {
      databasePath,
      rollingBufferWindowMs: 1_000n,
      fullOutageMaxWindowMs: 6_000n,
      pruneIntervalMs: 100n,
      pruneBatchSize,
      deliveredRetentionMs: 1_000n,
      deadLetterRetentionMs: 2_000n,
      walAutoCheckpointPages: 1_000,
    },
    () => nowMs,
  );

  try {
    for (let index = 0; index < 250; index += 1) {
      reservoir.appendIngressEvent(createEvent(`pending-${index}`, 0n), {
        sourcePath: "transport_normalized_stream",
        deliveryMode: "order_buffer_only",
        fullOutageActive: false,
      });
    }

    nowMs = 6_500n;
    const pruneResult = reservoir.pruneExpired(false);
    assert.equal(pruneResult.markedDeadLetter, 100);
    assert.equal(pruneResult.deletedRows, 0);
    assert.equal(reservoir.pruneExpired(false).markedDeadLetter, 100);
    assert.equal(reservoir.pruneExpired(false).markedDeadLetter, 50);
    assert.equal(reservoir.getStats().totalPendingRows, 0);
  } finally {
    reservoir.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runExpiredDeliveredScenario() {
  const workspace = mkdtempSync(join(tmpdir(), "monitor-prune-batching-delivered-"));
  const databasePath = join(workspace, "monitor.sqlite");
  const pruneBatchSize = 100;
  let nowMs = 0n;
  const reservoir = new SQLiteReservoir(
    {
      databasePath,
      rollingBufferWindowMs: 1_000n,
      fullOutageMaxWindowMs: 6_000n,
      pruneIntervalMs: 100n,
      pruneBatchSize,
      deliveredRetentionMs: 1_000n,
      deadLetterRetentionMs: 2_000n,
      walAutoCheckpointPages: 1_000,
    },
    () => nowMs,
  );

  try {
    for (let index = 0; index < 250; index += 1) {
      reservoir.appendIngressEvent(createEvent(`delivered-${index}`, 0n), {
        sourcePath: "deduped_observation",
        deliveryMode: "normal",
        replayState: "delivered",
        fullOutageActive: false,
      });
    }

    nowMs = 1_500n;
    const pruneResult = reservoir.pruneExpired(false);
    assert.equal(pruneResult.markedDeadLetter, 0);
    assert.equal(pruneResult.deletedRows, 100);
    assert.equal(reservoir.pruneExpired(false).deletedRows, 100);
    assert.equal(reservoir.pruneExpired(false).deletedRows, 50);
    assert.equal(reservoir.getStats().totalPendingRows, 0);
  } finally {
    reservoir.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

runExpiredPendingScenario();
runExpiredDeliveredScenario();

console.log(
  "prune batching passed: each prune call is bounded and repeated calls drain expired pending and terminal rows deterministically",
);

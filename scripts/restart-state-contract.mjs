import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMonitorRuntime,
  SQLiteReservoir,
} from "../.build/src/index.js";

const root = mkdtempSync(join(tmpdir(), "monitor-restart-state-"));
let now = 10_000n;
const clock = () => now;

function config(databasePath) {
  return {
    now: clock,
    reservoir: {
      databasePath,
      rollingBufferWindowMs: 100_000n,
      fullOutageMaxWindowMs: 200_000n,
      pruneIntervalMs: 1_000n,
      pruneBatchSize: 100,
    },
    replay: {
      healthConfirmationHeartbeats: 2,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 5_000n,
    },
  };
}

function event(id, ingestedAt) {
  return {
    id,
    nodeId: "restart-node",
    clock: { physicalTimeMs: ingestedAt },
    payload: { id },
    ingestedAt,
  };
}

function append(reservoir, id, ingestedAt, replayState = "pending", retryNotBeforeMs = null) {
  return reservoir.appendIngressEvent(event(id, ingestedAt), {
    sourcePath: "transport_normalized_stream",
    deliveryMode: "order_buffer_only",
    replayState,
    retryNotBeforeMs,
    monitorIngestAt: ingestedAt,
  });
}

try {
  const mixedPath = join(root, "mixed.sqlite");
  const original = new SQLiteReservoir(config(mixedPath).reservoir, clock);
  append(original, "pending-first", 1_000n);
  const interruptedId = append(original, "interrupted-second", 2_000n);
  append(original, "delivered", 3_000n, "delivered");
  append(original, "dead", 4_000n, "dead_letter");
  original.claimReplayBatch(2);
  original.markReplayBatchDelivered([1]);
  original.close();

  const restarted = createMonitorRuntime(config(mixedPath));
  assert.equal(restarted.getReservoirStats().totalPendingRows, 1);
  assert.equal(restarted.getReplaySnapshot().state, "queued");
  assert.equal(restarted.getReplaySnapshot().queuedEventCount, 1);
  assert.equal(restarted.getIngressDecision().action, "buffer_only");
  assert.equal(restarted.getInspectedSnapshot().liveFlowGateClosed, true);

  restarted.updateComponentHealth("dedupe", { state: "online" });
  restarted.updateComponentHealth("causal-order", { state: "online" });
  const batch = restarted.claimReplayBatch(10);
  assert.deepEqual(batch.entries.map((entry) => entry.rowId), [interruptedId]);
  assert.equal(batch.entries[0].replayAttempts, 2);
  restarted.acknowledgeReplayBatch([interruptedId]);
  assert.equal(restarted.getReservoirStats().totalPendingRows, 0);
  restarted.close();

  const retryPath = join(root, "retry.sqlite");
  const retryOriginal = new SQLiteReservoir(config(retryPath).reservoir, clock);
  const retryId = append(retryOriginal, "retry", 5_000n);
  retryOriginal.claimReplayBatch(1);
  retryOriginal.resetReplayBatchToPending([retryId], 15_000n);
  retryOriginal.close();

  const retryRestarted = createMonitorRuntime(config(retryPath));
  assert.equal(retryRestarted.getReplaySnapshot().state, "failed");
  assert.equal(retryRestarted.getReplaySnapshot().nextRetryAt, 15_000n);
  assert.equal(retryRestarted.getReplaySnapshot().consecutiveFailureCount, 1);
  assert.equal(retryRestarted.getReservoirStats().retryWaitingRows, 1);
  assert.equal(retryRestarted.getInspectedSnapshot().replayRetryBackoffActive, true);
  retryRestarted.updateComponentHealth("dedupe", { state: "online" });
  retryRestarted.updateComponentHealth("causal-order", { state: "online" });
  assert.throws(() => retryRestarted.claimReplayBatch(1), /retry|failed/i);
  now = 15_000n;
  const retryBatch = retryRestarted.claimReplayBatch(1);
  assert.deepEqual(retryBatch.entries.map((entry) => entry.rowId), [retryId]);
  assert.equal(retryBatch.entries[0].replayAttempts, 2);
  retryRestarted.close();

  const terminal = createMonitorRuntime(config(mixedPath));
  assert.equal(terminal.getReservoirStats().totalPendingRows, 0);
  assert.equal(terminal.getReplaySnapshot().state, "idle");
  terminal.close();

  console.log("Restart-state contract passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MonitorClosedError,
  MonitorIndeterminateOutcomeError,
  MonitorRuntime,
  SQLiteReservoir,
  TransportMonitorAdapter,
} from "../.build/src/index.js";

function config(databasePath, now = () => 100_000n) {
  return {
    now,
    reservoir: {
      databasePath,
      rollingBufferWindowMs: 100_000n,
      fullOutageMaxWindowMs: 200_000n,
      pruneIntervalMs: 1_000n,
      pruneBatchSize: 100,
    },
    replay: {
      healthConfirmationHeartbeats: 1,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 5_000n,
    },
  };
}

function event(id, ingestedAt = 10_000n) {
  return {
    id,
    nodeId: "shutdown-node",
    clock: { physicalTimeMs: ingestedAt },
    payload: { fixture: "shutdown", id },
    ingestedAt,
  };
}

function append(reservoir, id) {
  return reservoir.appendIngressEvent(event(id), {
    sourcePath: "transport_normalized_stream",
    deliveryMode: "order_buffer_only",
    monitorIngestAt: 10_000n,
  });
}

function barrier() {
  let release;
  let markArrived;
  const arrived = new Promise((resolve) => { markArrived = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  return {
    arrived,
    release,
    async wait() {
      markArrived();
      await waiting;
    },
  };
}

function setHealthy(adapter, observedAt = 100_000n) {
  for (const component of ["transport", "dedupe", "causal-order"]) {
    adapter.updateComponentHealth(component, {
      state: "online",
      observedAt,
      details: {},
    });
  }
}

function assertClosed(action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof MonitorClosedError);
    assert.equal(error.code, "ERR_MONITOR_CLOSED");
    return true;
  });
}

function testReservoirPostClose(root) {
  const databasePath = join(root, "reservoir-post-close.sqlite");
  const reservoir = new SQLiteReservoir(config(databasePath).reservoir, () => 100_000n);
  append(reservoir, "reservoir-existing");
  const schema = reservoir.getSchemaInfo();
  const pendingRows = reservoir.getPendingRowCount();
  const path = reservoir.getDatabasePath();
  reservoir.close();
  reservoir.close();

  assert.deepEqual(reservoir.getSchemaInfo(), schema);
  assert.equal(reservoir.getPendingRowCount(), pendingRows);
  assert.equal(reservoir.getDatabasePath(), path);

  const health = {
    component: "transport",
    state: "online",
    observedAt: 100_000n,
    reasonCode: null,
    details: {},
  };
  const replay = {
    state: "idle",
    targetPath: "dedupe_then_order",
    queuedEventCount: 0,
    deliveredEventCount: 0,
    startedAt: null,
    endedAt: null,
    lastError: null,
    nextRetryAt: null,
    consecutiveFailureCount: 0,
    recoveryHeartbeatCount: 0,
    requiredRecoveryHeartbeats: 1,
  };
  const operations = [
    () => append(reservoir, "after-close"),
    () => reservoir.recordHealthTransition(health),
    () => reservoir.recordReplaySnapshot(replay),
    () => reservoir.bumpReplayAttempts(),
    () => reservoir.updateReplayState(["pending"], "delivered"),
    () => reservoir.claimReplayBatch(1),
    () => reservoir.markReplayBatchDelivered([]),
    () => reservoir.markIngressRowsDelivered([]),
    () => reservoir.resetReplayBatchToPending([]),
    () => reservoir.deadLetterReplayBatch([]),
    () => reservoir.reclaimStaleReplayRows(-1n),
    () => reservoir.recoverRestartState(),
    () => reservoir.pruneExpired(),
    () => reservoir.checkpointWal("passive"),
    () => reservoir.getLifecycleStats(),
    () => reservoir.getStats(),
    () => reservoir.getStorageSnapshot(),
  ];
  for (const operation of operations) assertClosed(operation);
}

function testRuntimePostClose(root) {
  const databasePath = join(root, "runtime-post-close.sqlite");
  const runtime = new MonitorRuntime(config(databasePath));
  const cached = {
    config: runtime.getConfig(),
    schema: runtime.getSchemaInfo(),
    health: runtime.getHealthSnapshot(),
    replay: runtime.getReplaySnapshot(),
    needsRecovery: runtime.needsRecoveryReplay(),
    observedRecovery: runtime.hasObservedRecoveryTransition(),
    recoveryConfirmed: runtime.isReplayRecoveryConfirmed(),
  };
  runtime.close();
  runtime.close();

  assert.equal(runtime.getConfig(), cached.config);
  assert.deepEqual(runtime.getSchemaInfo(), cached.schema);
  assert.deepEqual(runtime.getHealthSnapshot(), cached.health);
  assert.deepEqual(runtime.getReplaySnapshot(), cached.replay);
  assert.equal(runtime.needsRecoveryReplay(), cached.needsRecovery);
  assert.equal(runtime.hasObservedRecoveryTransition(), cached.observedRecovery);
  assert.equal(runtime.isReplayRecoveryConfirmed(), cached.recoveryConfirmed);

  const operations = [
    () => runtime.getSnapshot(),
    () => runtime.getInspectedSnapshot(),
    () => runtime.getOperatorSnapshot(),
    () => runtime.getReservoirStats(),
    () => runtime.getReservoirLifecycleStats(),
    () => runtime.checkpointReservoirWal("passive"),
    () => runtime.getIngressDecision(),
    () => runtime.updateComponentHealth("transport", { state: "online" }),
    () => runtime.observeHeartbeat("transport"),
    () => runtime.setThrottleTier("open"),
    () => runtime.bindReplayOrchestrationOwner("manual"),
    () => runtime.queueReplay(),
    () => runtime.queueManagedReplay(),
    () => runtime.startReplay(),
    () => runtime.claimManagedReplayBatch(1),
    () => runtime.acknowledgeManagedReplayBatch([]),
    () => runtime.failManagedReplay("closed"),
    () => runtime.abortManagedReplay("closed"),
    () => runtime.claimReplayBatch(1),
    () => runtime.acknowledgeReplayBatch([]),
    () => runtime.acknowledgeIngressDelivery([]),
    () => runtime.failReplay("closed"),
    () => runtime.abortReplay("closed"),
    () => runtime.ingestTransportEvent(event("runtime-after-close")),
    () => runtime.observeDedupeEvent(event("dedupe-after-close")),
    () => runtime.pruneReservoir(),
    () => runtime.refreshHealthStates(),
  ];
  for (const operation of operations) assertClosed(operation);
}

async function testCloseDuringIngressDelivery(root) {
  const databasePath = join(root, "close-during-ingress.sqlite");
  const gate = barrier();
  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async () => gate.wait(),
      deliverToOrder: async () => {},
    },
    config(databasePath),
  );
  setHealthy(adapter);
  const inFlight = adapter.ingest(event("in-flight-ingress"));
  await gate.arrived;
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);
  adapter.close();
  adapter.close();
  gate.release();
  await assert.rejects(inFlight, (error) => {
    assert.ok(error instanceof MonitorIndeterminateOutcomeError);
    assert.equal(error.code, "ERR_MONITOR_OUTCOME_INDETERMINATE");
    assert.ok(error.cause instanceof MonitorClosedError);
    return true;
  });

  const reopened = new MonitorRuntime(config(databasePath));
  try {
    assert.equal(reopened.getReservoirStats().totalPendingRows, 1);
    const batch = reopened.claimReplayBatch(1);
    assert.deepEqual(batch.entries.map((entry) => entry.event.id), ["in-flight-ingress"]);
    reopened.acknowledgeReplayBatch(batch.entries.map((entry) => entry.rowId));
    assert.equal(reopened.getReservoirStats().totalPendingRows, 0);
  } finally {
    reopened.close();
  }
}

async function testCloseDuringReplayDelivery(root) {
  const databasePath = join(root, "close-during-replay.sqlite");
  const gate = barrier();
  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async (_entry, context) => {
        if (context.replay) await gate.wait();
      },
      deliverToOrder: async () => {},
    },
    config(databasePath),
  );
  setHealthy(adapter);
  adapter.updateComponentHealth("causal-order", {
    state: "offline",
    observedAt: 100_001n,
    details: {},
  });
  for (let index = 0; index < 2; index += 1) {
    const result = await adapter.ingest(event(`in-flight-replay-${index}`, 20_000n + BigInt(index)));
    assert.equal(result.forwardedTo, "buffer");
  }
  adapter.updateComponentHealth("causal-order", {
    state: "online",
    observedAt: 100_002n,
    details: {},
  });
  const inFlight = adapter.reconcileRecovery(2);
  await gate.arrived;
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 2);
  adapter.close();
  gate.release();
  await assert.rejects(inFlight, (error) => {
    assert.ok(error instanceof MonitorClosedError);
    assert.equal(error.code, "ERR_MONITOR_CLOSED");
    return true;
  });

  const reopened = new MonitorRuntime(config(databasePath));
  try {
    assert.equal(reopened.getReservoirStats().totalPendingRows, 2);
    const batch = reopened.claimReplayBatch(2);
    assert.deepEqual(
      batch.entries.map((entry) => entry.event.id),
      ["in-flight-replay-0", "in-flight-replay-1"],
    );
    reopened.acknowledgeReplayBatch(batch.entries.map((entry) => entry.rowId));
    assert.equal(reopened.getReservoirStats().totalPendingRows, 0);
  } finally {
    reopened.close();
  }
}

const root = mkdtempSync(join(tmpdir(), "monitor-shutdown-lifecycle-"));
try {
  testReservoirPostClose(root);
  testRuntimePostClose(root);
  await testCloseDuringIngressDelivery(root);
  await testCloseDuringReplayDelivery(root);
  console.log(
    "shutdown lifecycle contract passed: close is idempotent, cached evidence remains readable, post-close work is rejected consistently, and in-flight ingress/replay rows recover after reopen",
  );
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

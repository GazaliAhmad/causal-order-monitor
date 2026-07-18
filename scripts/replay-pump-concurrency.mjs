import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TransportMonitorAdapter } from "../.build/src/index.js";

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
      entityId: "entity-1",
      kind: "test",
    },
  };
}

function createAdapter(databasePath, handlers) {
  let nowMs = 0n;
  const adapter = new TransportMonitorAdapter(handlers, {
    now: () => nowMs,
    reservoir: {
      databasePath,
      rollingBufferWindowMs: 10_000n,
      fullOutageMaxWindowMs: 20_000n,
      pruneIntervalMs: 100n,
    },
    replay: {
      healthConfirmationHeartbeats: 1,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 1_000n,
    },
  });

  return {
    adapter,
    setNow(value) {
      nowMs = value;
    },
  };
}

function setRecoveryTransition(adapter) {
  adapter.updateComponentHealth("transport", {
    state: "online",
    observedAt: 0n,
    details: {},
  });
  adapter.updateComponentHealth("dedupe", {
    state: "online",
    observedAt: 0n,
    details: {},
  });
  adapter.updateComponentHealth("causal-order", {
    state: "offline",
    observedAt: 0n,
    details: {},
  });
}

async function seedRecovery(adapter, id) {
  setRecoveryTransition(adapter);
  const ingestResult = await adapter.ingest(createEvent(id, 0n));
  assert.equal(ingestResult.forwardedTo, "buffer");
  adapter.updateComponentHealth("causal-order", {
    state: "online",
    observedAt: 0n,
    details: {},
  });
}

async function runCompetingPumpScenario(workspace) {
  let releaseDelivery;
  let replayStarted;
  const replayStartedPromise = new Promise((resolve) => {
    replayStarted = resolve;
  });
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  let replayCalls = 0;
  const { adapter } = createAdapter(join(workspace, "pump.sqlite"), {
    deliverToDedupe: async (_event, context) => {
      if (!context.replay) return;
      replayCalls += 1;
      replayStarted();
      await deliveryGate;
    },
    deliverToOrder: async () => {},
  });

  try {
    await seedRecovery(adapter, "competing-pump");
    adapter.getRuntime().queueManagedReplay();

    const first = adapter.pumpReplayBatch(1);
    await replayStartedPromise;
    const second = adapter.pumpReplayBatch(100);
    releaseDelivery();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(replayCalls, 1, "competing pump calls must deliver one replay entry");
    assert.equal(firstResult.claimedCount, 1);
    assert.equal(secondResult.claimedCount, 1);
    assert.equal(firstResult.deliveredCount, 1);
    assert.equal(secondResult.deliveredCount, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  } finally {
    adapter.close();
  }
}

async function runReconcileThenPumpScenario(workspace) {
  let releaseDelivery;
  let replayStarted;
  const replayStartedPromise = new Promise((resolve) => {
    replayStarted = resolve;
  });
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  let replayCalls = 0;
  const { adapter } = createAdapter(join(workspace, "reconcile-pump.sqlite"), {
    deliverToDedupe: async (_event, context) => {
      if (!context.replay) return;
      replayCalls += 1;
      replayStarted();
      await deliveryGate;
    },
    deliverToOrder: async () => {},
  });

  try {
    await seedRecovery(adapter, "reconcile-then-pump");
    const first = adapter.reconcileRecovery(1);
    await replayStartedPromise;
    const second = adapter.pumpReplayBatch(100);
    releaseDelivery();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.ok(firstResult);
    assert.ok(secondResult);
    assert.equal(replayCalls, 1, "reconcile and pump must share one operation");
    assert.equal(firstResult.deliveredCount, 1);
    assert.equal(secondResult.deliveredCount, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  } finally {
    adapter.close();
  }
}

async function runPumpThenReconcileScenario(workspace) {
  let releaseDelivery;
  let replayStarted;
  const replayStartedPromise = new Promise((resolve) => {
    replayStarted = resolve;
  });
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  let replayCalls = 0;
  const { adapter } = createAdapter(join(workspace, "pump-reconcile.sqlite"), {
    deliverToDedupe: async (_event, context) => {
      if (!context.replay) return;
      replayCalls += 1;
      replayStarted();
      await deliveryGate;
    },
    deliverToOrder: async () => {},
  });

  try {
    await seedRecovery(adapter, "pump-then-reconcile");
    adapter.getRuntime().queueManagedReplay();
    const first = adapter.pumpReplayBatch(1);
    await replayStartedPromise;
    const second = adapter.reconcileRecovery(100);
    releaseDelivery();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.ok(secondResult);
    assert.equal(replayCalls, 1, "pump and reconcile must share one operation");
    assert.equal(firstResult.deliveredCount, 1);
    assert.equal(secondResult.deliveredCount, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  } finally {
    adapter.close();
  }
}

async function runCompetingReconcileScenario(workspace) {
  let releaseDelivery;
  let replayStarted;
  const replayStartedPromise = new Promise((resolve) => {
    replayStarted = resolve;
  });
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  let replayCalls = 0;
  const { adapter } = createAdapter(join(workspace, "reconcile-reconcile.sqlite"), {
    deliverToDedupe: async (_event, context) => {
      if (!context.replay) return;
      replayCalls += 1;
      replayStarted();
      await deliveryGate;
    },
    deliverToOrder: async () => {},
  });

  try {
    await seedRecovery(adapter, "competing-reconcile");
    const first = adapter.reconcileRecovery(1);
    await replayStartedPromise;
    const second = adapter.reconcileRecovery(100);
    releaseDelivery();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.ok(firstResult);
    assert.ok(secondResult);
    assert.equal(replayCalls, 1, "competing reconcile calls must share one operation");
    assert.equal(firstResult.deliveredCount, 1);
    assert.equal(secondResult.deliveredCount, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  } finally {
    adapter.close();
  }
}

async function runFailureRecoveryScenario(workspace) {
  let replayCalls = 0;
  const { adapter, setNow } = createAdapter(join(workspace, "failure-recovery.sqlite"), {
    deliverToDedupe: async (_event, context) => {
      if (!context.replay) return;
      replayCalls += 1;
      if (replayCalls === 1) throw new Error("replay failure for guard test");
    },
    deliverToOrder: async () => {},
  });

  try {
    await seedRecovery(adapter, "failure-recovery");
    const failed = await adapter.reconcileRecovery(1);
    assert.ok(failed);
    assert.equal(failed.snapshot.state, "failed");

    setNow(1_000n);
    const duringBackoff = await adapter.reconcileRecovery(1);
    assert.equal(duringBackoff, null);
    assert.equal(replayCalls, 1);
  } finally {
    adapter.close();
  }
}

async function runNoOpCrossMethodScenario(workspace) {
  const { adapter } = createAdapter(join(workspace, "no-op-cross-method.sqlite"), {
    deliverToDedupe: async () => {},
    deliverToOrder: async () => {},
  });

  try {
    const reconcile = adapter.reconcileRecovery(1);
    const pump = adapter.pumpReplayBatch(1);
    const [reconcileResult, pumpResult] = await Promise.all([reconcile, pump]);
    assert.equal(reconcileResult, null);
    assert.equal(pumpResult.claimedCount, 0);
    assert.equal(pumpResult.deliveredCount, 0);
    assert.equal(pumpResult.completed, true);
  } finally {
    adapter.close();
  }
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-replay-pump-concurrency-"));
try {
  await runCompetingPumpScenario(workspace);
  await runReconcileThenPumpScenario(workspace);
  await runPumpThenReconcileScenario(workspace);
  await runCompetingReconcileScenario(workspace);
  await runFailureRecoveryScenario(workspace);
  await runNoOpCrossMethodScenario(workspace);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "replay pump concurrency passed: competing pump/reconcile calls coalesce to one in-flight adapter operation, preserve first-call limits, and clear after failure",
);

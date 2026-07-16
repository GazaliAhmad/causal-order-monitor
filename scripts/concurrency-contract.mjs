import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MonitorRuntime,
  TransportMonitorAdapter,
} from "../.build/src/index.js";

function event(id, ingestedAt) {
  return {
    id,
    nodeId: "concurrency-node",
    clock: { physicalTimeMs: ingestedAt },
    payload: { fixture: "concurrency", id },
    ingestedAt,
  };
}

function config(databasePath, now) {
  return {
    now,
    reservoir: {
      databasePath,
      rollingBufferWindowMs: 100_000n,
      fullOutageMaxWindowMs: 200_000n,
      pruneIntervalMs: 1_000n,
      pruneBatchSize: 50,
      walAutoCheckpointPages: 0,
    },
    replay: {
      healthConfirmationHeartbeats: 1,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 5_000n,
    },
  };
}

function barrier(requiredArrivals) {
  let arrivals = 0;
  let release;
  let markArrived;
  const arrived = new Promise((resolve) => { markArrived = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  return {
    arrived,
    release,
    async wait() {
      arrivals += 1;
      if (arrivals === requiredArrivals) markArrived();
      await waiting;
    },
  };
}

function setHealthy(adapter, now) {
  for (const component of ["transport", "dedupe", "causal-order"]) {
    adapter.updateComponentHealth(component, {
      state: "online",
      observedAt: now,
      details: { fixture: "concurrency" },
    });
  }
}

async function testConcurrentIngressAndInspection(root) {
  const databasePath = join(root, "concurrent-ingress.sqlite");
  const gate = barrier(4);
  const delivered = [];
  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async (entry) => {
        delivered.push(entry.id);
        await gate.wait();
      },
      deliverToOrder: async () => {},
    },
    config(databasePath, () => 10_000n),
  );
  try {
    setHealthy(adapter, 10_000n);
    const ingests = Array.from({ length: 4 }, (_, index) =>
      adapter.ingest(event(`overlap-${index}`, 1_000n + BigInt(index))),
    );
    await gate.arrived;
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 4);
    assert.equal(adapter.getInspectedSnapshot().liveFlowGateClosed, false);
    const ingressOperator = adapter.getOperatorSnapshot();
    assert.equal(ingressOperator.backlog.totalRows, 4);
    assert.doesNotThrow(() => JSON.stringify(ingressOperator));
    gate.release();
    const results = await Promise.all(ingests);
    assert.deepEqual(results.map((result) => result.rowId), [1, 2, 3, 4]);
    assert.deepEqual(delivered, ["overlap-0", "overlap-1", "overlap-2", "overlap-3"]);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
    assert.deepEqual(adapter.getRuntime().getReservoirLifecycleStats(), {
      deliveredRows: 4,
      deadLetterRows: 0,
    });
  } finally {
    adapter.close();
  }
}

async function testHealthChangeDuringDelivery(root) {
  const databasePath = join(root, "health-during-delivery.sqlite");
  const gate = barrier(1);
  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async () => gate.wait(),
      deliverToOrder: async () => {},
    },
    config(databasePath, () => 20_000n),
  );
  try {
    setHealthy(adapter, 20_000n);
    const inFlight = adapter.ingest(event("before-health-change", 10_000n));
    await gate.arrived;
    adapter.updateComponentHealth("causal-order", {
      state: "offline",
      observedAt: 20_001n,
      details: { fixture: "interleaving" },
    });
    const buffered = await adapter.ingest(event("after-health-change", 10_001n));
    assert.equal(buffered.forwardedTo, "buffer");
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 2);
    gate.release();
    const delivered = await inFlight;
    assert.equal(delivered.forwardedTo, "dedupe");
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);
    assert.deepEqual(adapter.getRuntime().getReservoirLifecycleStats(), {
      deliveredRows: 1,
      deadLetterRows: 0,
    });
  } finally {
    adapter.close();
  }
}

async function testReplayInspectionPruneAndCheckpoint(root) {
  const databasePath = join(root, "replay-interleaving.sqlite");
  const gate = barrier(1);
  const replayDeliveries = [];
  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async (entry, context) => {
        if (context.replay) {
          replayDeliveries.push(entry.id);
          await gate.wait();
        }
      },
      deliverToOrder: async () => {},
    },
    config(databasePath, () => 30_000n),
  );
  try {
    setHealthy(adapter, 30_000n);
    adapter.updateComponentHealth("causal-order", {
      state: "offline",
      observedAt: 30_001n,
      details: {},
    });
    for (let index = 0; index < 3; index += 1) {
      const result = await adapter.ingest(event(`replay-${index}`, 20_000n + BigInt(index)));
      assert.equal(result.forwardedTo, "buffer");
    }
    adapter.updateComponentHealth("causal-order", {
      state: "online",
      observedAt: 30_002n,
      details: {},
    });
    const replay = adapter.reconcileRecovery(3);
    await gate.arrived;
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 3);
    assert.equal(adapter.getInspectedSnapshot().liveFlowGateClosed, true);
    const replayOperator = adapter.getOperatorSnapshot();
    assert.equal(replayOperator.replay.gateClosed, true);
    assert.equal(replayOperator.backlog.totalRows, 3);
    assert.doesNotThrow(() => JSON.stringify(replayOperator));
    assert.deepEqual(adapter.getRuntime().pruneReservoir(), {
      markedDeadLetter: 0,
      deletedRows: 0,
    });
    assert.equal(adapter.getRuntime().checkpointReservoirWal("passive").busy, false);
    gate.release();
    const replayResult = await replay;
    assert.ok(replayResult);
    assert.equal(replayResult.claimedCount, 3);
    assert.equal(replayResult.deliveredCount, 3);
    assert.deepEqual(replayDeliveries, ["replay-0", "replay-1", "replay-2"]);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  } finally {
    adapter.close();
  }
}

async function testBoundedStressAndReopen(root) {
  const databasePath = join(root, "bounded-stress.sqlite");
  let now = 100_000n;
  const runtime = new MonitorRuntime(config(databasePath, () => now));
  const expectedOrder = [];
  try {
    for (const component of ["transport", "dedupe", "causal-order"]) {
      runtime.updateComponentHealth(component, {
        state: component === "causal-order" ? "offline" : "online",
        observedAt: now,
        details: {},
      });
    }

    const tasks = Array.from({ length: 300 }, (_, index) =>
      Promise.resolve().then(() => {
        const id = `stress-${String(index).padStart(3, "0")}`;
        expectedOrder.push(id);
        runtime.ingestTransportEvent(event(id, now + BigInt(index)));
        if (index % 25 === 0) {
          const operator = runtime.getOperatorSnapshot();
          assert.doesNotThrow(() => JSON.stringify(operator));
        }
        if (index % 50 === 0) runtime.pruneReservoir();
        if (index % 75 === 0) runtime.checkpointReservoirWal("passive");
      }),
    );
    await Promise.all(tasks);
    assert.equal(runtime.getReservoirStats().totalPendingRows, 300);

    now += 1n;
    runtime.updateComponentHealth("causal-order", {
      state: "online",
      observedAt: now,
      details: {},
    });
    runtime.queueReplay();
    const actualOrder = [];
    while (runtime.getReservoirStats().totalPendingRows > 0) {
      const batch = runtime.claimReplayBatch(37);
      assert.ok(batch.entries.length > 0);
      actualOrder.push(...batch.entries.map((entry) => entry.event.id));
      runtime.acknowledgeReplayBatch(batch.entries.map((entry) => entry.rowId));
      const operator = runtime.getOperatorSnapshot();
      assert.doesNotThrow(() => JSON.stringify(operator));
    }
    assert.deepEqual(actualOrder, expectedOrder);
    assert.equal(runtime.getReservoirStats().totalPendingRows, 0);
    assert.deepEqual(runtime.getReservoirLifecycleStats(), {
      deliveredRows: 300,
      deadLetterRows: 0,
    });
  } finally {
    runtime.close();
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const counts = db.prepare(
      `SELECT replay_state, COUNT(*) AS count
         FROM ingress_events
         GROUP BY replay_state`,
    ).all();
    assert.deepEqual(counts.map((entry) => ({
      replayState: entry.replay_state,
      count: Number(entry.count),
    })), [{ replayState: "delivered", count: 300 }]);
  } finally {
    db.close();
  }

  const reopened = new MonitorRuntime(config(databasePath, () => now));
  try {
    assert.equal(reopened.getReservoirStats().totalPendingRows, 0);
    assert.deepEqual(reopened.getReservoirLifecycleStats(), {
      deliveredRows: 300,
      deadLetterRows: 0,
    });
  } finally {
    reopened.close();
  }
}

const root = mkdtempSync(join(tmpdir(), "monitor-concurrency-"));
try {
  await testConcurrentIngressAndInspection(root);
  await testHealthChangeDuringDelivery(root);
  await testReplayInspectionPruneAndCheckpoint(root);
  await testBoundedStressAndReopen(root);
  console.log(
    "concurrency contract passed: operator inspection overlapped ingress, replay, prune, checkpoint, and 300-event stress while preserving ordering, gating, and reopen state",
  );
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

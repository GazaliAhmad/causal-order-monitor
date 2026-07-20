import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MONITOR_LIFECYCLE_EVENT_NAMES,
  MonitorCapacityRefusedError,
  MonitorIndeterminateOutcomeError,
  TransportMonitorAdapter,
  createMonitorRuntime,
} from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-lifecycle-instrumentation-"));
const allObservedTypes = new Set();

const event = (id) => ({
  id,
  nodeId: "node-a",
  clock: { physicalTimeMs: 1n },
  payload: {
    entityId: `entity-${id}`,
    payload: { nestedSecret: true },
    payloadJson: "application-value",
    serializedEvent: "application-value",
  },
});

function subscribeAll(owner) {
  const observed = [];
  for (const type of MONITOR_LIFECYCLE_EVENT_NAMES) {
    owner.lifecycle.subscribe(type, (evidence) => {
      observed.push(evidence);
      allObservedTypes.add(evidence.type);
    });
  }
  return observed;
}

function types(observed) {
  return observed.map((item) => item.type);
}

function rowState(databasePath, rowId) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare("SELECT replay_state FROM ingress_events WHERE rowid = ?")
      .get(rowId)?.replay_state ?? null;
  } finally {
    db.close();
  }
}

function rowExistsByEventId(databasePath, eventId) {
  const db = new DatabaseSync(databasePath);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM ingress_events WHERE event_id = ?")
      .get(eventId).count) === 1;
  } finally {
    db.close();
  }
}

try {
  {
    const databasePath = join(workspace, "adapter-success.sqlite");
    const adapter = new TransportMonitorAdapter(
      { deliverToDedupe() {}, deliverToOrder() {} },
      { reservoir: { databasePath }, now: () => 100n },
    );
    const observed = subscribeAll(adapter);
    adapter.lifecycle.subscribe("ingressAccepted", () => { throw new Error("isolated sync listener"); });
    adapter.lifecycle.subscribe("ingressAccepted", async () => { throw new Error("isolated async listener"); });
    const result = await adapter.ingest(event("success"));
    await adapter.lifecycle.flush();
    assert.equal(adapter.lifecycle.getSnapshot().listenerFailureTotal, 2);
    assert.equal(rowExistsByEventId(databasePath, "success"), true);
    assert.equal(rowState(databasePath, result.rowId), "delivered");
    const rowEvents = observed.filter((item) => item.rowId === result.rowId);
    assert.deepEqual(
      types(rowEvents),
      ["ingressAccepted", "deliveryAttempted", "deliveryHandlerCompleted", "deliveryAcknowledged"],
    );
    for (const evidence of observed) {
      assert.equal("payload" in evidence, false);
      assert.equal("payloadJson" in evidence, false);
      assert.equal("serializedEvent" in evidence, false);
      assert.equal(Object.isFrozen(evidence), true);
    }
    adapter.close();
  }

  {
    const databasePath = join(workspace, "adapter-failure.sqlite");
    const adapter = new TransportMonitorAdapter(
      {
        deliverToDedupe() { throw new Error("downstream rejected"); },
        deliverToOrder() { throw new Error("downstream rejected"); },
      },
      { reservoir: { databasePath }, now: () => 200n },
    );
    const observed = subscribeAll(adapter);
    await assert.rejects(() => adapter.ingest(event("handler-failure")), MonitorIndeterminateOutcomeError);
    await adapter.lifecycle.flush();
    const accepted = observed.find((item) => item.type === "ingressAccepted");
    assert.equal(rowState(databasePath, accepted.rowId), "pending");
    assert.ok(types(observed).includes("deliveryFailed"));
    assert.equal(types(observed).includes("deliveryAcknowledged"), false);
    adapter.close();
  }

  {
    const databasePath = join(workspace, "adapter-indeterminate.sqlite");
    const adapter = new TransportMonitorAdapter(
      {
        deliverToDedupe() {},
        deliverToOrder() {},
        onDecision() { throw new Error("decision callback failed"); },
      },
      { reservoir: { databasePath }, now: () => 300n },
    );
    const observed = subscribeAll(adapter);
    await assert.rejects(() => adapter.ingest(event("indeterminate")), MonitorIndeterminateOutcomeError);
    await adapter.lifecycle.flush();
    const accepted = observed.find((item) => item.type === "ingressAccepted");
    assert.equal(rowState(databasePath, accepted.rowId), "pending");
    assert.ok(types(observed).includes("deliveryIndeterminate"));
    assert.equal(types(observed).includes("deliveryAttempted"), false);
    adapter.close();
  }

  {
    const databasePath = join(workspace, "refusal.sqlite");
    const runtime = createMonitorRuntime({
      reservoir: { databasePath, capacity: { maxPendingRows: 0 } },
      now: () => 400n,
    });
    const observed = subscribeAll(runtime);
    await assert.rejects(
      async () => runtime.ingestTransportEvent(event("refused")),
      MonitorCapacityRefusedError,
    );
    await runtime.lifecycle.flush();
    assert.deepEqual(types(observed).filter((type) => type.startsWith("ingress")), [
      "ingressAttempted", "ingressRefused",
    ]);
    assert.equal(rowExistsByEventId(databasePath, "refused"), false);
    runtime.close();
  }

  {
    const databasePath = join(workspace, "storage-failure.sqlite");
    const runtime = createMonitorRuntime({ reservoir: { databasePath }, now: () => 500n });
    const observed = subscribeAll(runtime);
    runtime.ingestTransportEvent(event("stored-before-lock"));
    const blocker = new DatabaseSync(databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    assert.throws(() => runtime.ingestTransportEvent(event("blocked-write")));
    blocker.exec("ROLLBACK");
    blocker.close();
    await runtime.lifecycle.flush();
    assert.ok(types(observed).includes("storageAppendFailed"));
    assert.equal(observed.filter((item) => item.type === "ingressAccepted").length, 1);
    runtime.close();
  }

  {
    const databasePath = join(workspace, "replay-success.sqlite");
    const runtime = createMonitorRuntime({ reservoir: { databasePath }, now: () => 600n });
    const observed = subscribeAll(runtime);
    const { rowId } = runtime.ingestTransportEvent(event("replay-success"));
    runtime.queueReplay();
    const batch = runtime.claimReplayBatch(1);
    await runtime.lifecycle.flush();
    assert.equal(rowState(databasePath, rowId), "replaying");
    assert.ok(types(observed).includes("replayBatchClaimed"));
    runtime.acknowledgeReplayBatch(batch.entries.map((entry) => entry.rowId));
    await runtime.lifecycle.flush();
    assert.equal(rowState(databasePath, rowId), "delivered");
    assert.ok(types(observed).includes("replayBatchAcknowledged"));
    assert.ok(observed.some((item) => item.type === "deliveryAcknowledged" && item.replay === true));
    assert.ok(observed.some((item) => item.type === "replayStateChanged" && item.state === "completed"));
    runtime.close();
  }

  {
    const databasePath = join(workspace, "replay-failure.sqlite");
    const runtime = createMonitorRuntime({ reservoir: { databasePath }, now: () => 700n });
    const observed = subscribeAll(runtime);
    const { rowId } = runtime.ingestTransportEvent(event("replay-failure"));
    runtime.queueReplay();
    const batch = runtime.claimReplayBatch(1);
    runtime.failReplay("expected replay failure", batch.entries.map((entry) => entry.rowId));
    await runtime.lifecycle.flush();
    assert.equal(rowState(databasePath, rowId), "pending");
    assert.ok(types(observed).includes("replayBatchFailed"));
    assert.ok(observed.some((item) => item.type === "replayStateChanged" && item.state === "failed"));
    runtime.close();
  }

  {
    const databasePath = join(workspace, "adapter-replay.sqlite");
    const adapter = new TransportMonitorAdapter(
      { deliverToDedupe() {}, deliverToOrder() {} },
      { reservoir: { databasePath }, now: () => 800n },
    );
    const observed = subscribeAll(adapter);
    const { rowId } = adapter.getRuntime().ingestTransportEvent(event("adapter-replay"));
    const result = await adapter.pumpReplayBatch(1);
    await adapter.lifecycle.flush();
    assert.equal(result.deliveredCount, 1);
    assert.equal(rowState(databasePath, rowId), "delivered");
    const rowEvents = observed.filter((item) => item.rowId === rowId);
    assert.deepEqual(types(rowEvents), [
      "ingressAccepted",
      "deliveryAttempted",
      "deliveryHandlerCompleted",
      "deliveryAcknowledged",
    ]);
    assert.ok(types(observed).includes("replayBatchClaimed"));
    assert.ok(types(observed).includes("replayBatchAcknowledged"));
    adapter.close();
  }

  {
    const databasePath = join(workspace, "serialization-refusal.sqlite");
    const runtime = createMonitorRuntime({ reservoir: { databasePath }, now: () => 900n });
    const observed = subscribeAll(runtime);
    const cyclic = event("cyclic");
    cyclic.payload.self = cyclic.payload;
    assert.throws(() => runtime.ingestTransportEvent(cyclic));
    await runtime.lifecycle.flush();
    assert.ok(observed.some(
      (item) => item.type === "ingressRefused" &&
        item.reasonCode === "MONITOR_INGRESS_SERIALIZATION_FAILED",
    ));
    assert.equal(types(observed).includes("storageAppendFailed"), false);
    assert.equal(rowExistsByEventId(databasePath, "cyclic"), false);
    runtime.close();
  }

  {
    let now = 1_000n;
    const databasePath = join(workspace, "retention-dead-letter.sqlite");
    const runtime = createMonitorRuntime({
      reservoir: {
        databasePath,
        rollingBufferWindowMs: 10n,
        fullOutageMaxWindowMs: 20n,
        deadLetterRetentionMs: 10_000n,
      },
      now: () => now,
    });
    const observed = subscribeAll(runtime);
    const { rowId } = runtime.ingestTransportEvent(event("dead-letter"));
    now = 2_000n;
    runtime.pruneReservoir();
    await runtime.lifecycle.flush();
    assert.equal(rowState(databasePath, rowId), "dead_letter");
    assert.ok(types(observed).includes("retentionDeadLettered"));
    runtime.close();
  }

  {
    let now = 3_000n;
    const databasePath = join(workspace, "retention-delete.sqlite");
    const runtime = createMonitorRuntime({
      reservoir: { databasePath, deliveredRetentionMs: 0n },
      now: () => now,
    });
    const observed = subscribeAll(runtime);
    const rowId = runtime.observeDedupeEvent(event("terminal-delete"));
    now = 3_001n;
    runtime.pruneReservoir();
    await runtime.lifecycle.flush();
    assert.equal(rowState(databasePath, rowId), null);
    assert.ok(types(observed).includes("retentionDeleted"));
    runtime.close();
  }

  {
    const databasePath = join(workspace, "operations.sqlite");
    const runtime = createMonitorRuntime({
      reservoir: { databasePath, capacity: { maxPendingRows: 1 } },
      now: () => 4_000n,
    });
    const observed = subscribeAll(runtime);
    runtime.updateComponentHealth("dedupe", { state: "offline" });
    runtime.getOperatorSnapshot();
    runtime.capacity.getSnapshot();
    runtime.ingestTransportEvent(event("capacity-full"));
    runtime.capacity.getSnapshot();
    runtime.checkpointReservoirWal("passive");
    await runtime.lifecycle.flush();
    assert.ok(types(observed).includes("healthChanged"));
    assert.ok(types(observed).includes("storagePressureObserved"));
    assert.ok(types(observed).includes("capacityPressureChanged"));
    assert.ok(types(observed).includes("storageCheckpointCompleted"));
    assert.ok(types(observed).includes("operationDurationObserved"));
    runtime.close();
  }

  assert.deepEqual([...allObservedTypes].sort(), [...MONITOR_LIFECYCLE_EVENT_NAMES].sort());
  console.log("Lifecycle instrumentation contract passed all 20 truthful boundaries.");
} finally {
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // A failed assertion can leave a SQLite handle open; preserve the assertion.
  }
}

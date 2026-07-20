import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MONITOR_LIFECYCLE_EVENT_NAMES,
  MonitorClosedError,
  TransportMonitorAdapter,
  createDefaultMonitorConfig,
  createMonitorRuntime,
  parseMonitorConfigJson,
  resolveMonitorConfig,
} from "../.build/src/index.js";
import { LifecycleDispatcher } from "../.build/src/lifecycle/LifecycleDispatcher.js";

const snapshotKeys = [
  "schema", "version", "generatedAtMs", "status", "queueDepth",
  "queueCapacity", "overflowPolicy", "subscriberCount", "droppedTotal",
  "listenerFailureTotal", "lastDrop",
];
const expectedEvents = [
  "ingressAttempted", "ingressAccepted", "ingressRefused",
  "storageAppendFailed", "storageCheckpointCompleted", "deliveryAttempted",
  "deliveryHandlerCompleted", "deliveryAcknowledged", "deliveryFailed",
  "deliveryIndeterminate", "replayStateChanged", "replayBatchClaimed",
  "replayBatchAcknowledged", "replayBatchFailed", "retentionDeadLettered",
  "retentionDeleted", "healthChanged", "storagePressureObserved",
  "capacityPressureChanged", "operationDurationObserved",
];

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const event = (eventId, occurredAtMs = "1") => ({
  type: "ingressAttempted", occurredAtMs, eventId,
});
const createDispatcher = (queueCapacity = 4) => {
  let clock = 100n;
  return new LifecycleDispatcher(
    { queueCapacity, overflowPolicy: "drop_oldest", shutdownFlushTimeoutMs: 100n },
    () => clock++,
  );
};

assert.deepEqual(MONITOR_LIFECYCLE_EVENT_NAMES, expectedEvents);
assert.equal(Object.isFrozen(MONITOR_LIFECYCLE_EVENT_NAMES), true);
assert.deepEqual(createDefaultMonitorConfig().lifecycle, {
  queueCapacity: 1024,
  overflowPolicy: "drop_oldest",
  shutdownFlushTimeoutMs: 1000n,
});
assert.deepEqual(
  resolveMonitorConfig(parseMonitorConfigJson(JSON.stringify({
    lifecycle: {
      queueCapacity: 7,
      overflowPolicy: "drop_oldest",
      shutdownFlushTimeoutMs: "2s",
    },
  }))).lifecycle,
  { queueCapacity: 7, overflowPolicy: "drop_oldest", shutdownFlushTimeoutMs: 2000n },
);
assert.throws(() => resolveMonitorConfig(parseMonitorConfigJson('{"lifecycle":{"extra":true}}')));
assert.throws(() => resolveMonitorConfig(parseMonitorConfigJson('{"lifecycle":{"queueCapacity":0}}')));
assert.throws(() => resolveMonitorConfig(parseMonitorConfigJson('{"lifecycle":{"overflowPolicy":"drop_newest"}}')));
assert.throws(() => resolveMonitorConfig(parseMonitorConfigJson('{"lifecycle":{"shutdownFlushTimeoutMs":"-1ms"}}')));

const workspace = mkdtempSync(join(tmpdir(), "monitor-lifecycle-contract-"));
try {
  const runtime = createMonitorRuntime({
    reservoir: { databasePath: join(workspace, "runtime.sqlite") },
  });
  const adapter = new TransportMonitorAdapter(
    { deliverToDedupe() {}, deliverToOrder() {} },
    { reservoir: { databasePath: join(workspace, "adapter.sqlite") } },
  );
  assert.equal(adapter.lifecycle, adapter.getRuntime().lifecycle);
  const snapshot = runtime.lifecycle.getSnapshot();
  assert.deepEqual(Object.keys(snapshot), snapshotKeys);
  assert.deepEqual(snapshot, {
    schema: "causal-order-monitor/lifecycle-snapshot",
    version: 1,
    generatedAtMs: snapshot.generatedAtMs,
    status: "open",
    queueDepth: 0,
    queueCapacity: 1024,
    overflowPolicy: "drop_oldest",
    subscriberCount: 0,
    droppedTotal: 0,
    listenerFailureTotal: 0,
    lastDrop: null,
  });
  adapter.close();
  assert.equal(adapter.lifecycle.getSnapshot().status, "closed");
  assert.throws(
    () => adapter.lifecycle.subscribe("ingressAttempted", () => {}),
    MonitorClosedError,
  );
  assert.equal((await adapter.lifecycle.flush()).status, "closed");
  runtime.close();
  runtime.close();
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

{
  const dispatcher = createDispatcher();
  const received = [];
  const mutable = {
    ...event("original"),
    details: { label: "before", payload: { secret: true } },
    payload: { secret: true },
    payloadJson: "secret",
    serializedEvent: "secret",
  };
  dispatcher.subscribe("ingressAttempted", (evidence) => received.push(evidence));
  assert.equal(dispatcher.publish(mutable), true);
  mutable.eventId = "mutated";
  mutable.details.label = "after";
  assert.equal((await dispatcher.flush()).status, "drained");
  assert.equal(received[0].eventId, "original");
  assert.equal(received[0].details.label, "before");
  assert.equal(Object.isFrozen(received[0]), true);
  assert.equal(Object.isFrozen(received[0].details), true);
  assert.equal("payload" in received[0], false);
  assert.equal("payloadJson" in received[0], false);
  assert.equal("serializedEvent" in received[0], false);
  assert.equal("payload" in received[0].details, false);
  dispatcher.close();
}

{
  const dispatcher = createDispatcher();
  const selected = [];
  let duplicateCalls = 0;
  const duplicate = () => { duplicateCalls += 1; };
  const unsubscribeDuplicateOne = dispatcher.subscribe("ingressAttempted", duplicate);
  const unsubscribeDuplicateTwo = dispatcher.subscribe("ingressAttempted", duplicate);
  let unsubscribeSecond = () => {};
  dispatcher.subscribe("ingressAttempted", () => {
    selected.push("first");
    unsubscribeSecond();
  });
  unsubscribeSecond = dispatcher.subscribe("ingressAttempted", () => selected.push("second"));
  dispatcher.subscribe("ingressAccepted", () => selected.push("wrong-event"));
  dispatcher.publish(event("one"));
  await dispatcher.flush();
  unsubscribeDuplicateOne();
  dispatcher.publish(event("two", "2"));
  await dispatcher.flush();
  unsubscribeDuplicateTwo();
  unsubscribeSecond();
  assert.deepEqual(selected, ["first", "second", "first"]);
  assert.equal(duplicateCalls, 3);
  dispatcher.close();
}

{
  const dispatcher = createDispatcher();
  const good = [];
  dispatcher.subscribe("ingressAttempted", () => { throw new Error("sync failure"); });
  dispatcher.subscribe("ingressAttempted", async () => { throw new Error("async failure"); });
  dispatcher.subscribe("ingressAttempted", (observed) => good.push(observed.eventId));
  dispatcher.publish(event("isolated"));
  await dispatcher.flush();
  assert.deepEqual(good, ["isolated"]);
  assert.equal(dispatcher.getSnapshot().listenerFailureTotal, 2);
  dispatcher.close();
}

{
  const dispatcher = createDispatcher(2);
  const gate = deferred();
  const received = [];
  dispatcher.subscribe("ingressAttempted", async (observed) => {
    received.push(observed.eventId);
    if (observed.eventId === "active") await gate.promise;
  });
  assert.equal(dispatcher.publish(event("active")), true);
  await turn();
  dispatcher.publish(event("dropped", "2"));
  dispatcher.publish(event("kept-1", "3"));
  dispatcher.publish(event("kept-2", "4"));
  assert.equal(dispatcher.getSnapshot().queueDepth, 2);
  assert.equal(dispatcher.getSnapshot().droppedTotal, 1);
  assert.deepEqual(dispatcher.getSnapshot().lastDrop, {
    occurredAtMs: dispatcher.getSnapshot().lastDrop.occurredAtMs,
    eventType: "ingressAttempted",
    reason: "queue_overflow",
  });
  assert.equal((await dispatcher.flush(0n)).status, "timed_out");
  gate.resolve();
  assert.equal((await dispatcher.flush()).status, "drained");
  assert.deepEqual(received, ["active", "kept-1", "kept-2"]);
  dispatcher.close();
}

{
  const dispatcher = createDispatcher(2);
  const gate = deferred();
  dispatcher.subscribe("ingressAttempted", async (observed) => {
    if (observed.eventId === "active") await gate.promise;
  });
  dispatcher.publish(event("active"));
  await turn();
  dispatcher.publish(event("queued-1", "2"));
  dispatcher.publish(event("queued-2", "3"));
  dispatcher.close();
  dispatcher.close();
  const closed = dispatcher.getSnapshot();
  assert.equal(closed.status, "closed");
  assert.equal(closed.queueDepth, 0);
  assert.equal(closed.subscriberCount, 0);
  assert.equal(closed.droppedTotal, 2);
  assert.equal(closed.lastDrop.reason, "shutdown");
  assert.equal(dispatcher.publish(event("after-close", "4")), false);
  assert.equal((await dispatcher.flush()).status, "closed");
  assert.throws(() => dispatcher.subscribe("ingressAttempted", () => {}), MonitorClosedError);
  gate.resolve();
  await turn();
  assert.equal(dispatcher.getSnapshot().listenerFailureTotal, 0);
}

assert.throws(
  () => new LifecycleDispatcher(
    { queueCapacity: 0, overflowPolicy: "drop_oldest", shutdownFlushTimeoutMs: 1n },
    () => 1n,
  ),
);

console.log("Lifecycle public model and bounded dispatcher contract passed.");

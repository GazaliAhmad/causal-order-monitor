import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

import { DedupeGateway } from "@causal-order/dedupe";
import {
  TransportOperationError,
  WebSocketJsonTransport,
  createEventId,
} from "@causal-order/transport";
import { orderEvents } from "causal-order";

import { TransportMonitorAdapter } from "../.build/src/transport.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "reserved port should have an address");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isWithin(parentPath, candidatePath) {
  const child = relative(parentPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

const workspace = mkdtempSync(join(tmpdir(), "causal-order-monitor-transport-stop-"));
const databasePath = join(workspace, "monitor.sqlite");
const deliveryGate = deferred();
const dedupe = new DedupeGateway({ autoCleanup: false });
const pendingMonitorOperations = new Set();
const transmissionIds = new Set();
const transportErrors = [];
const lifecycleEvents = [];
let receiverCallbacks = 0;
let callbacksAfterClientStop = 0;
let explicitFailures = 0;
let dedupeAccepted = 0;
let dedupeDuplicates = 0;
let dedupeDecisions = 0;
let orderedEvents = 0;
let clientStopCompleted = false;
let server;
let client;
let adapter;

try {
  adapter = new TransportMonitorAdapter({
    async deliverToDedupe(event) {
      await deliveryGate.promise;
      dedupeDecisions += 1;
      if (dedupe.filter({ id: event.id, nodeId: event.nodeId, sequence: event.sequence })) {
        dedupeAccepted += 1;
        const orderResult = orderEvents([event], { strict: false, detectAnomalies: true });
        assert.equal(orderResult.ordered.length, 1, "each dedupe-accepted event should be orderable");
        orderedEvents += orderResult.ordered.length;
      } else {
        dedupeDuplicates += 1;
      }
    },
    deliverToOrder() {
      throw new Error("the positive transport contract must remain on the dedupe path");
    },
  }, {
    reservoir: { databasePath },
    startup: { healthPolicy: "conservative" },
    lifecycle: { queueCapacity: 256, shutdownFlushTimeoutMs: 5_000n },
  });

  for (const eventName of ["ingressAccepted", "deliveryAcknowledged", "deliveryFailed"]) {
    adapter.lifecycle.subscribe(eventName, (event) => lifecycleEvents.push(event));
  }
  for (const component of ["transport", "dedupe", "causal-order"]) {
    adapter.observeHeartbeat(component);
  }

  const port = await reservePort();
  server = new WebSocketJsonTransport({
    mode: "server",
    host: "127.0.0.1",
    port,
    deliveryTimeoutMs: 5_000,
    shutdownTimeoutMs: 5_000,
    maxInFlightReceives: 32,
    maxInFlightReceivesPerPeer: 32,
  });
  server.onError((error) => transportErrors.push(error));
  server.onDelivery((event, context) => {
    receiverCallbacks += 1;
    if (clientStopCompleted) callbacksAfterClientStop += 1;
    assert.equal(context.rawMessage.schema, "causal-order/transport");
    assert.equal(context.rawMessage.version, 1);
    assert.equal(context.rawMessage.type, "event");
    assert.equal(typeof context.rawMessage.transmissionId, "string");
    assert.notEqual(context.rawMessage.transmissionId, event.id);
    transmissionIds.add(context.rawMessage.transmissionId);

    const operation = adapter.ingest(event, context.connectionId);
    pendingMonitorOperations.add(operation);
    return operation.then(
      () => ({ outcome: "accepted" }),
      (error) => {
        explicitFailures += 1;
        return {
          outcome: "refused",
          code: error instanceof TransportOperationError ? error.code : "MONITOR_DELIVERY_REFUSED",
          detail: error instanceof Error ? error.message : String(error),
        };
      },
    ).finally(() => pendingMonitorOperations.delete(operation));
  });

  client = new WebSocketJsonTransport({
    mode: "client",
    url: `ws://127.0.0.1:${port}`,
    peerId: "monitor-stop-client",
    acknowledgmentTimeoutMs: 5_000,
    shutdownTimeoutMs: 5_000,
    maxInFlightSends: 32,
    maxInFlightSendsPerPeer: 32,
  });
  client.onError((error) => transportErrors.push(error));

  await server.start();
  await client.start();

  const uniqueEvents = Array.from({ length: 8 }, (_, index) => ({
    id: createEventId("transport-stop", index + 1),
    nodeId: "transport-stop",
    sequence: BigInt(index + 1),
    clock: {
      physicalTimeMs: 10_000n + BigInt(index),
      logicalCounter: 0,
      nodeId: "transport-stop",
    },
    payload: { index: index + 1 },
  }));
  const transmissions = [
    ...uniqueEvents,
    uniqueEvents[2],
    uniqueEvents[2],
    uniqueEvents[6],
  ];

  let settledSends = 0;
  const sends = transmissions.map((event) => client.send(event).finally(() => {
    settledSends += 1;
  }));
  let stopSettled = false;
  const clientStop = client.stop().finally(() => {
    clientStopCompleted = true;
    stopSettled = true;
  });

  await waitFor(
    () => receiverCallbacks === transmissions.length,
    "all accepted transmissions to enter the monitor delivery boundary",
  );
  assert.equal(settledSends, 0, "send acknowledgements must await monitor delivery completion");
  assert.equal(stopSettled, false, "transport stop must wait for monitor delivery completion");
  assert.equal(pendingMonitorOperations.size, transmissions.length);

  deliveryGate.resolve();
  const sendResults = await Promise.allSettled(sends);
  await clientStop;

  assert.ok(
    sendResults.every((result) => result.status === "fulfilled"),
    `positive sends should all be acknowledged: ${sendResults.map((result) =>
      result.status === "fulfilled"
        ? "fulfilled"
        : `${result.reason?.code ?? result.reason?.name}: ${result.reason?.message ?? String(result.reason)}`
    ).join(" | ")}`,
  );
  assert.equal(receiverCallbacks + explicitFailures, transmissions.length);
  assert.equal(transmissionIds.size, transmissions.length, "duplicates require independent transmission IDs");
  assert.equal(callbacksAfterClientStop, 0);

  const callbacksAtStop = receiverCallbacks;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(receiverCallbacks, callbacksAtStop, "no receiver callback may arrive after successful client stop");

  await server.stop();

  assert.equal(dedupeAccepted + dedupeDuplicates, dedupeDecisions);
  assert.equal(dedupeDecisions, receiverCallbacks);
  assert.equal(dedupeAccepted, uniqueEvents.length);
  assert.equal(dedupeDuplicates, transmissions.length - uniqueEvents.length);
  assert.equal(orderedEvents, dedupeAccepted);
  const finalReservoir = adapter.getRuntime().getReservoirStats();
  const finalReplay = adapter.getReplaySnapshot();
  const finalOperator = adapter.getOperatorSnapshot();
  assert.equal(finalReservoir.totalPendingRows, 0);
  assert.equal(pendingMonitorOperations.size, 0);
  assert.equal(finalReplay.state, "idle");
  assert.equal(finalOperator.replay.gateClosed, false);
  assert.equal(
    lifecycleEvents.filter((event) => event.type === "ingressAccepted").length,
    transmissions.length,
  );
  assert.equal(
    lifecycleEvents.filter((event) => event.type === "deliveryAcknowledged").length,
    transmissions.length,
  );
  assert.equal(lifecycleEvents.some((event) => event.type === "deliveryFailed"), false);
  assert.equal(transportErrors.length, 0, `unexpected transport errors: ${JSON.stringify(transportErrors)}`);
  const lifecycleFlush = await adapter.lifecycle.flush(5_000n);
  assert.equal(lifecycleFlush.status, "drained");
  const finalLifecycle = adapter.lifecycle.getSnapshot();
  assert.equal(finalLifecycle.queueDepth, 0);

  console.log(JSON.stringify({
    transport: "0.2.0",
    acceptedTransmissions: transmissions.length,
    receiverCallbacks,
    explicitFailures,
    uniqueTransmissionIds: transmissionIds.size,
    dedupeAccepted,
    dedupeDuplicates,
    dedupeDecisions,
    orderedEvents,
    callbacksAfterSuccessfulStop: callbacksAfterClientStop,
    monitorPendingRows: finalReservoir.totalPendingRows,
    monitorPendingOperations: pendingMonitorOperations.size,
    lifecycleQueueDepth: finalLifecycle.queueDepth,
    recoveryGateClosed: finalOperator.replay.gateClosed,
  }, null, 2));
  console.log("Transport 0.2 acknowledged-send stop contract passed with complete terminal accounting.");
} finally {
  deliveryGate.resolve();
  if (client && client.state !== "stopped" && client.state !== "idle") {
    await client.stop().catch(() => {});
  }
  if (server && server.state !== "stopped" && server.state !== "idle") {
    await server.stop().catch(() => {});
  }
  adapter?.close();
  dedupe.destroy();
  const resolvedWorkspace = realpathSync(workspace);
  const resolvedTemp = realpathSync(tmpdir());
  assert.ok(
    isWithin(resolvedTemp, resolvedWorkspace) &&
      basename(resolvedWorkspace).startsWith("causal-order-monitor-transport-stop-"),
    "temporary cleanup target should remain scoped to the transport-stop workspace",
  );
  rmSync(resolvedWorkspace, { recursive: true, force: true });
}

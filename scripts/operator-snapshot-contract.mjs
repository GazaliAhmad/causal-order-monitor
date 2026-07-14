import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MonitorAdmissionRefusedError,
  MonitorRuntime,
  TransportMonitorAdapter,
  deriveMonitorAdmissionDecision,
  inspectMonitorSnapshotV1,
} from "../.build/src/index.js";

function createEvent(id, ingestedAt) {
  return {
    id,
    nodeId: "operator-contract-node",
    clock: { physicalTimeMs: ingestedAt },
    ingestedAt,
    payload: { kind: "operator-contract" },
  };
}

function assertJsonSafe(value) {
  const json = JSON.stringify(value);
  assert.equal(json.includes("n}"), false);
  assert.deepEqual(JSON.parse(json), value);
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-operator-contract-"));
let nowMs = 10_000n;
const adapter = new TransportMonitorAdapter(
  {
    deliverToDedupe: async () => {},
    deliverToOrder: async () => {},
  },
  {
    now: () => nowMs,
    reservoir: { databasePath: join(workspace, "monitor.sqlite") },
  },
);

try {
  for (const component of ["transport", "dedupe", "causal-order"]) {
    adapter.updateComponentHealth(component, {
      state: "online",
      observedAt: nowMs,
      details: {},
    });
  }

  const liveSnapshot = adapter.getOperatorSnapshot();
  assertJsonSafe(liveSnapshot);
  assert.equal(typeof liveSnapshot.storage.databaseBytes, "string");
  let snapshot = inspectMonitorSnapshotV1(adapter.getSnapshot(), {
    pressure: "normal",
    databaseBytes: "4096",
    walBytes: "0",
    filesystemAvailableBytes: "1000000000",
    filesystemTotalBytes: "2000000000",
    filesystemUsedPercent: 50,
  });
  assert.equal(snapshot.schema, "causal-order-monitor/operator-snapshot");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.status, "healthy");
  assert.deepEqual(snapshot.affectedComponents, []);
  assert.equal(snapshot.recommendedAction, "none");
  assert.deepEqual(snapshot.admission, {
    posture: "accepted_live",
    accepted: true,
    httpStatus: 202,
    reasonCode: "MONITOR_LIVE_FLOW_AVAILABLE",
  });
  assert.equal(typeof snapshot.generatedAtMs, "string");
  assertJsonSafe(snapshot);

  adapter.updateComponentHealth("causal-order", {
    state: "offline",
    observedAt: nowMs,
    reasonCode: "ORDER_UNREACHABLE",
    details: {},
  });
  const buffered = await adapter.ingest(createEvent("buffered", nowMs));
  assert.deepEqual(buffered.admission, {
    posture: "accepted_buffered",
    accepted: true,
    httpStatus: 202,
    reasonCode: "MONITOR_OUTAGE_BUFFERING",
  });
  snapshot = inspectMonitorSnapshotV1(adapter.getSnapshot(), snapshot.storage);
  assert.equal(snapshot.status, "buffering");
  assert.deepEqual(snapshot.affectedComponents, ["causal-order"]);
  assert.equal(snapshot.recommendedAction, "restore_affected_components");
  assert.equal(snapshot.backlog.totalRows, 1);
  assert.equal(snapshot.admission.posture, "accepted_buffered");
  assertJsonSafe(snapshot);

  const refusedDecision = {
    action: "pause",
    routingMode: "dedupe_bypass_throttled",
    deliveryMode: "dedupe_bypass",
    throttleTier: "paused",
    targetEventsPerSecond: 0,
    targetBatchSize: 0,
    reason: "protective stop",
  };
  assert.deepEqual(deriveMonitorAdmissionDecision(refusedDecision), {
    posture: "protective_refusal",
    accepted: false,
    httpStatus: 503,
    reasonCode: "MONITOR_PROTECTIVE_THROTTLE",
  });
  const refusalSnapshot = inspectMonitorSnapshotV1({
    ...adapter.getSnapshot(),
    routingMode: "dedupe_bypass_throttled",
    throttleTier: "paused",
  }, snapshot.storage);
  assert.equal(refusalSnapshot.status, "protective_refusal");
  assert.equal(refusalSnapshot.recommendedAction, "relieve_protective_pressure");
  assert.equal(refusalSnapshot.admission.httpStatus, 503);
  const refused = new MonitorAdmissionRefusedError(refusedDecision);
  assert.equal(refused.code, "ERR_MONITOR_ADMISSION_REFUSED");
  assert.equal(refused.outcome, "definite_rejection");
  assert.equal(refused.httpStatus, 503);
  assertJsonSafe(refused.toJSON());
} finally {
  adapter.close();
  rmSync(workspace, { recursive: true, force: true });
}

const memoryRuntime = new MonitorRuntime({ reservoir: { databasePath: ":memory:" } });
try {
  assert.equal(memoryRuntime.getOperatorSnapshot().storage.pressure, "unknown");
} finally {
  memoryRuntime.close();
}

console.log(
  "operator snapshot contract passed: schema v1 is JSON-safe and maps healthy, buffered, storage, and refusal semantics deterministically",
);

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as rootModule from "@causal-order/monitor";
import * as configModule from "@causal-order/monitor/config";
import * as runtimeModule from "@causal-order/monitor/runtime";
import * as storageModule from "@causal-order/monitor/storage";
import * as transportModule from "@causal-order/monitor/transport";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

function sorted(values) {
  return [...values].sort();
}

function ownKeys(value) {
  return sorted(Object.keys(value));
}

function prototypeMethods(value) {
  return sorted(
    Object.getOwnPropertyNames(value.prototype).filter((name) => name !== "constructor"),
  );
}

assert.deepEqual(sorted(Object.keys(packageJson.exports)), [
  ".",
  "./config",
  "./health",
  "./inspect",
  "./package.json",
  "./replay",
  "./routing",
  "./runtime",
  "./storage",
  "./testing",
  "./throttle",
  "./transport",
  "./types",
]);

assert.deepEqual(ownKeys(rootModule), sorted([
  "DEFAULT_MONITOR_CONFIG_FILE",
  "DeliveryRouter",
  "HealthTracker",
  "MONITOR_CONFIG_ENV_VAR",
  "MonitorRuntime",
  "ReplayCoordinator",
  "ReplayOwnershipError",
  "SQLiteReservoir",
  "ThrottleController",
  "TransportMonitorAdapter",
  "createDefaultMonitorConfig",
  "createDefaultMonitorNow",
  "createMonitorRuntime",
  "createMonitorRuntimeFromEnvironment",
  "createMonitorRuntimeFromFile",
  "createTransportMonitorAdapterFromEnvironment",
  "createTransportMonitorAdapterFromFile",
  "inspectMonitorSnapshot",
  "loadMonitorConfigFile",
  "loadMonitorConfigFromEnvironment",
  "monitorHarnessArtifacts",
  "monitorHarnessScenarios",
  "monitorImplementationStatus",
  "monitorPackageVersion",
  "parseMonitorConfigJson",
  "resolveMonitorConfig",
  "resolveMonitorConfigFromEnvironment",
]));
assert.deepEqual(ownKeys(configModule), sorted([
  "DEFAULT_MONITOR_CONFIG_FILE",
  "MONITOR_CONFIG_ENV_VAR",
  "createDefaultMonitorConfig",
  "createDefaultMonitorNow",
  "loadMonitorConfigFile",
  "loadMonitorConfigFromEnvironment",
  "parseMonitorConfigJson",
  "resolveMonitorConfig",
  "resolveMonitorConfigFromEnvironment",
]));
assert.deepEqual(ownKeys(runtimeModule), sorted([
  "MonitorRuntime",
  "ReplayOwnershipError",
  "createMonitorRuntime",
  "createMonitorRuntimeFromEnvironment",
  "createMonitorRuntimeFromFile",
]));
assert.deepEqual(ownKeys(storageModule), sorted([
  "MONITOR_SQLITE_SCHEMA_VERSION",
  "MonitorSchemaCompatibilityError",
  "MonitorSchemaError",
  "MonitorSchemaMigrationError",
  "MonitorSchemaVersionError",
  "SQLiteReservoir",
]));
assert.deepEqual(ownKeys(transportModule), sorted([
  "TransportMonitorAdapter",
  "createTransportMonitorAdapterFromEnvironment",
  "createTransportMonitorAdapterFromFile",
]));

assert.deepEqual(prototypeMethods(storageModule.SQLiteReservoir), sorted([
  "appendIngressEvent",
  "bumpReplayAttempts",
  "checkpointWal",
  "claimReplayBatch",
  "close",
  "deadLetterReplayBatch",
  "getDatabasePath",
  "getLifecycleStats",
  "getPendingRowCount",
  "getSchemaInfo",
  "getStats",
  "markIngressRowsDelivered",
  "markReplayBatchDelivered",
  "pruneExpired",
  "reclaimStaleReplayRows",
  "recordHealthTransition",
  "recordReplaySnapshot",
  "recoverRestartState",
  "resetReplayBatchToPending",
  "updateReplayState",
]));
assert.deepEqual(prototypeMethods(runtimeModule.MonitorRuntime), sorted([
  "abortManagedReplay",
  "abortReplay",
  "acknowledgeIngressDelivery",
  "acknowledgeManagedReplayBatch",
  "acknowledgeReplayBatch",
  "bindReplayOrchestrationOwner",
  "checkpointReservoirWal",
  "claimManagedReplayBatch",
  "claimReplayBatch",
  "close",
  "failManagedReplay",
  "failReplay",
  "getConfig",
  "getHealthSnapshot",
  "getIngressDecision",
  "getInspectedSnapshot",
  "getReplaySnapshot",
  "getReservoirLifecycleStats",
  "getReservoirStats",
  "getSchemaInfo",
  "getSnapshot",
  "hasObservedRecoveryTransition",
  "ingestTransportEvent",
  "isReplayRecoveryConfirmed",
  "needsRecoveryReplay",
  "observeDedupeEvent",
  "observeHeartbeat",
  "pruneReservoir",
  "queueManagedReplay",
  "queueReplay",
  "refreshHealthStates",
  "setThrottleTier",
  "startReplay",
  "updateComponentHealth",
]));
assert.deepEqual(prototypeMethods(transportModule.TransportMonitorAdapter), sorted([
  "close",
  "getInspectedSnapshot",
  "getReplaySnapshot",
  "getRuntime",
  "getSnapshot",
  "ingest",
  "observeHeartbeat",
  "pumpReplayBatch",
  "reconcileRecovery",
  "updateComponentHealth",
]));

const defaults = configModule.createDefaultMonitorConfig();
assert.deepEqual(ownKeys(defaults), [
  "health",
  "now",
  "replay",
  "reservoir",
  "throttle",
  "transport",
]);
assert.deepEqual(ownKeys(defaults.reservoir), [
  "databasePath",
  "deadLetterRetentionMs",
  "deliveredRetentionMs",
  "fullOutageMaxWindowMs",
  "pruneBatchSize",
  "pruneIntervalMs",
  "rollingBufferWindowMs",
  "walAutoCheckpointPages",
]);
assert.equal(storageModule.MONITOR_SQLITE_SCHEMA_VERSION, 2);

const workspace = mkdtempSync(join(tmpdir(), "monitor-compatibility-audit-"));
const databasePath = join(workspace, "monitor.sqlite");
const runtime = new runtimeModule.MonitorRuntime({
  now: () => 100_000n,
  reservoir: { databasePath },
});
try {
  const snapshot = runtime.getSnapshot();
  assert.deepEqual(ownKeys(snapshot), [
    "components",
    "generatedAt",
    "replay",
    "reservoir",
    "routingMode",
    "throttleTier",
  ]);
  assert.deepEqual(ownKeys(snapshot.reservoir), [
    "earliestRetryAt",
    "oldestPendingAgeMs",
    "pendingRowsByDeliveryMode",
    "pendingRowsBySourcePath",
    "retryWaitingRows",
    "totalPendingRows",
  ]);
  assert.deepEqual(ownKeys(snapshot.replay), [
    "consecutiveFailureCount",
    "deliveredEventCount",
    "endedAt",
    "lastError",
    "nextRetryAt",
    "queuedEventCount",
    "recoveryHeartbeatCount",
    "requiredRecoveryHeartbeats",
    "startedAt",
    "state",
    "targetPath",
  ]);
  assert.deepEqual(ownKeys(runtime.getInspectedSnapshot()), sorted([
    "earliestRetryAt",
    "generatedAt",
    "liveFlowGateClosed",
    "liveFlowGateReason",
    "oldestPendingAgeMs",
    "operationalState",
    "replayBacklogRemainingRows",
    "replayConsecutiveFailureCount",
    "replayDeliveredEventCount",
    "replayNextRetryAt",
    "replayProgressPercent",
    "replayQueuedEventCount",
    "replayReadyRows",
    "replayRetryBackoffActive",
    "replayRetryDelayMs",
    "replayState",
    "requiresOperatorAttention",
    "retryWaitingRows",
    "routingMode",
    "throttleTier",
    "totalPendingRows",
    "unhealthyComponents",
  ]));
  assert.deepEqual(ownKeys(runtime.getReservoirLifecycleStats()), [
    "deadLetterRows",
    "deliveredRows",
  ]);
  assert.deepEqual(ownKeys(runtime.checkpointReservoirWal("passive")), [
    "busy",
    "checkpointedFrames",
    "logFrames",
    "mode",
  ]);
  assert.deepEqual(ownKeys(runtime.pruneReservoir()), [
    "deletedRows",
    "markedDeadLetter",
  ]);
} finally {
  runtime.close();
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual(
    db.prepare("PRAGMA table_info(ingress_events)").all().map((column) => column.name),
    [
      "monitor_ingest_seq",
      "id",
      "monitor_ingest_at_ms",
      "source_node_id",
      "source_stream_id",
      "source_path",
      "event_id",
      "trace_id",
      "sequence",
      "logical_time_ms",
      "payload_json",
      "payload_encoding",
      "delivery_mode",
      "replay_state",
      "replay_attempts",
      "retry_not_before_ms",
      "replay_claimed_at_ms",
      "terminal_at_ms",
      "expires_at_ms",
    ],
  );
} finally {
  db.close();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(
  "compatibility audit passed: v0.2.2 exports, class methods, config/result/snapshot shapes, and schema-v2 columns remain unchanged",
);

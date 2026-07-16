import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as rootModule from "@causal-order/monitor";
import * as configModule from "@causal-order/monitor/config";
import * as healthModule from "@causal-order/monitor/health";
import * as inspectModule from "@causal-order/monitor/inspect";
import * as replayModule from "@causal-order/monitor/replay";
import * as routingModule from "@causal-order/monitor/routing";
import * as runtimeModule from "@causal-order/monitor/runtime";
import * as storageModule from "@causal-order/monitor/storage";
import * as testingModule from "@causal-order/monitor/testing";
import * as throttleModule from "@causal-order/monitor/throttle";
import * as transportModule from "@causal-order/monitor/transport";
import * as typesModule from "@causal-order/monitor/types";
import { v030PublicContract } from "./fixtures/v0.3.0-public-contract.mjs";

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

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

assert.deepEqual(sorted(Object.keys(packageJson.exports)), v030PublicContract.packageSubpaths);

const runtimeNamespaces = {
  root: rootModule,
  config: configModule,
  health: healthModule,
  inspect: inspectModule,
  replay: replayModule,
  routing: routingModule,
  runtime: runtimeModule,
  storage: storageModule,
  testing: testingModule,
  throttle: throttleModule,
  transport: transportModule,
  types: typesModule,
};
for (const [name, expectedExports] of Object.entries(v030PublicContract.runtimeNamespaces)) {
  assert.deepEqual(ownKeys(runtimeNamespaces[name]), sorted(expectedExports), `${name} runtime exports`);
}

assert.deepEqual(prototypeMethods(storageModule.SQLiteReservoir), sorted(
  v030PublicContract.prototypes.SQLiteReservoir,
));
assert.deepEqual(prototypeMethods(runtimeModule.MonitorRuntime), sorted(
  v030PublicContract.prototypes.MonitorRuntime,
));
assert.deepEqual(prototypeMethods(transportModule.TransportMonitorAdapter), sorted(
  v030PublicContract.prototypes.TransportMonitorAdapter,
));

const defaults = configModule.createDefaultMonitorConfig();
assert.deepEqual(ownKeys(defaults), v030PublicContract.configKeys.root);
assert.deepEqual(ownKeys(defaults.reservoir), v030PublicContract.configKeys.reservoir);
assert.equal(storageModule.MONITOR_SQLITE_SCHEMA_VERSION, v030PublicContract.schema.version);

for (const [declarationPath, fragments] of Object.entries(v030PublicContract.declarationFragments)) {
  const declaration = normalizeWhitespace(readFileSync(declarationPath, "utf8"));
  for (const fragment of fragments) {
    assert.ok(
      declaration.includes(normalizeWhitespace(fragment)),
      `${declarationPath} should preserve v0.3.0 declaration fragment: ${fragment}`,
    );
  }
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-compatibility-audit-"));
const databasePath = join(workspace, "monitor.sqlite");
const runtime = new runtimeModule.MonitorRuntime({
  now: () => 100_000n,
  reservoir: { databasePath },
});
try {
  const snapshot = runtime.getSnapshot();
  assert.deepEqual(ownKeys(snapshot), v030PublicContract.snapshotKeys.raw);
  assert.deepEqual(ownKeys(snapshot.reservoir), v030PublicContract.snapshotKeys.rawReservoir);
  assert.deepEqual(ownKeys(snapshot.replay), v030PublicContract.snapshotKeys.rawReplay);
  assert.deepEqual(ownKeys(runtime.getInspectedSnapshot()), sorted(
    v030PublicContract.snapshotKeys.inspected,
  ));
  const operatorSnapshot = runtime.getOperatorSnapshot();
  assert.deepEqual(ownKeys(operatorSnapshot), sorted(v030PublicContract.snapshotKeys.operator));
  assert.deepEqual(ownKeys(operatorSnapshot.admission), v030PublicContract.snapshotKeys.admission);
  assert.deepEqual(ownKeys(operatorSnapshot.backlog), v030PublicContract.snapshotKeys.backlog);
  assert.deepEqual(ownKeys(operatorSnapshot.replay), v030PublicContract.snapshotKeys.operatorReplay);
  assert.deepEqual(ownKeys(operatorSnapshot.storage), v030PublicContract.snapshotKeys.storage);
  assert.equal(operatorSnapshot.schema, "causal-order-monitor/operator-snapshot");
  assert.equal(operatorSnapshot.version, 1);
  assert.doesNotThrow(() => JSON.stringify(operatorSnapshot));
  assert.deepEqual(ownKeys(runtime.getReservoirLifecycleStats()), v030PublicContract.resultKeys.lifecycle);
  assert.deepEqual(ownKeys(runtime.checkpointReservoirWal("passive")), v030PublicContract.resultKeys.checkpoint);
  assert.deepEqual(ownKeys(runtime.pruneReservoir()), v030PublicContract.resultKeys.prune);
} finally {
  runtime.close();
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, v030PublicContract.schema.version);
  const tableNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(tableNames, Object.keys(v030PublicContract.schema.tables).sort());
  for (const [tableName, expectedColumns] of Object.entries(v030PublicContract.schema.tables)) {
    assert.deepEqual(
      db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name),
      expectedColumns,
      `${tableName} columns`,
    );
  }
  const indexNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(indexNames, v030PublicContract.schema.indexes);
} finally {
  db.close();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(
  "compatibility audit passed: retained v0.3.0 package subpaths, runtime exports, declarations, methods, config, snapshots, results, stable values, and complete schema-v2 layout are protected",
);

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

function assertOwnExport(moduleNamespace, exportName, sourceLabel) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(moduleNamespace, exportName),
    `${sourceLabel} should export ${exportName}`,
  );
}

function assertPathExists(pathValue, description) {
  const resolvedPath = resolve(pathValue);
  assert.ok(existsSync(resolvedPath), `${description} should exist at ${resolvedPath}`);
}

for (const [subpath, exportTarget] of Object.entries(packageJson.exports)) {
  if (subpath === "./package.json") {
    continue;
  }

  if (typeof exportTarget === "string") {
    assertPathExists(exportTarget, `${subpath} export target`);
    continue;
  }

  if (exportTarget?.import) {
    assertPathExists(exportTarget.import, `${subpath} import target`);
  }

  if (exportTarget?.types) {
    assertPathExists(exportTarget.types, `${subpath} types target`);
  }
}

const root = await import("@causal-order/monitor");
const config = await import("@causal-order/monitor/config");
const health = await import("@causal-order/monitor/health");
const inspect = await import("@causal-order/monitor/inspect");
const replay = await import("@causal-order/monitor/replay");
const routing = await import("@causal-order/monitor/routing");
const runtime = await import("@causal-order/monitor/runtime");
const storage = await import("@causal-order/monitor/storage");
const testing = await import("@causal-order/monitor/testing");
const throttle = await import("@causal-order/monitor/throttle");
const transport = await import("@causal-order/monitor/transport");
const types = await import("@causal-order/monitor/types");

const rootOnlyExports = [
  "monitorPackageVersion",
  "monitorImplementationStatus",
  "createDefaultMonitorNow",
  "monitorHarnessArtifacts",
  "monitorHarnessScenarios",
];

const firstWaveDeprecatedRootValueExports = [
  {
    exportName: "HealthTracker",
    subpathModule: health,
    subpathLabel: "@causal-order/monitor/health",
  },
  {
    exportName: "ReplayCoordinator",
    subpathModule: replay,
    subpathLabel: "@causal-order/monitor/replay",
  },
  {
    exportName: "DeliveryRouter",
    subpathModule: routing,
    subpathLabel: "@causal-order/monitor/routing",
  },
  {
    exportName: "ThrottleController",
    subpathModule: throttle,
    subpathLabel: "@causal-order/monitor/throttle",
  },
];

for (const exportName of rootOnlyExports) {
  assertOwnExport(root, exportName, "@causal-order/monitor");
}

for (const { exportName, subpathModule, subpathLabel } of firstWaveDeprecatedRootValueExports) {
  assertOwnExport(root, exportName, "@causal-order/monitor");
  assertOwnExport(subpathModule, exportName, subpathLabel);
}

const rootDts = readFileSync(resolve(".build/src/index.d.ts"), "utf8");
const replayDts = readFileSync(resolve(".build/src/replay.d.ts"), "utf8");
const typesDts = readFileSync(resolve(".build/src/types.d.ts"), "utf8");

assert.match(
  rootDts,
  /export type ReplayBatch = ReplayBatchType;/,
  "the root declaration surface should keep exporting the deprecated ReplayBatch type alias during the compatibility window",
);
assert.match(
  replayDts,
  /export \{ ReplayCoordinator, type ReplayBatch \}/,
  "the replay subpath declaration surface should keep exporting ReplayBatch as the replacement type path",
);
assert.match(
  rootDts,
  /type MonitorEventTimingEvidence/,
  "the root declaration surface should export neutral event timing evidence",
);
assert.match(
  typesDts,
  /type MonitorEventTimingEvidence/,
  "the types subpath should export neutral event timing evidence",
);

const rootAndSubpathChecks = [
  {
    exportName: "createDefaultMonitorNow",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "createDefaultMonitorConfig",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "DEFAULT_MONITOR_CONFIG_FILE",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "MONITOR_CONFIG_ENV_VAR",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "parseMonitorConfigJson",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "resolveMonitorConfig",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "loadMonitorConfigFile",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "resolveMonitorConfigFromEnvironment",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "loadMonitorConfigFromEnvironment",
    rootModule: root,
    subpathModule: config,
    subpathLabel: "@causal-order/monitor/config",
  },
  {
    exportName: "inspectMonitorSnapshot",
    rootModule: root,
    subpathModule: inspect,
    subpathLabel: "@causal-order/monitor/inspect",
  },
  {
    exportName: "inspectMonitorSnapshotV1",
    rootModule: root,
    subpathModule: inspect,
    subpathLabel: "@causal-order/monitor/inspect",
  },
  {
    exportName: "createMonitorRuntime",
    rootModule: root,
    subpathModule: runtime,
    subpathLabel: "@causal-order/monitor/runtime",
  },
  {
    exportName: "createMonitorRuntimeFromEnvironment",
    rootModule: root,
    subpathModule: runtime,
    subpathLabel: "@causal-order/monitor/runtime",
  },
  {
    exportName: "createMonitorRuntimeFromFile",
    rootModule: root,
    subpathModule: runtime,
    subpathLabel: "@causal-order/monitor/runtime",
  },
  {
    exportName: "MonitorRuntime",
    rootModule: root,
    subpathModule: runtime,
    subpathLabel: "@causal-order/monitor/runtime",
  },
  {
    exportName: "ReplayOwnershipError",
    rootModule: root,
    subpathModule: runtime,
    subpathLabel: "@causal-order/monitor/runtime",
  },
  {
    exportName: "SQLiteReservoir",
    rootModule: root,
    subpathModule: storage,
    subpathLabel: "@causal-order/monitor/storage",
  },
  {
    exportName: "createTransportMonitorAdapterFromEnvironment",
    rootModule: root,
    subpathModule: transport,
    subpathLabel: "@causal-order/monitor/transport",
  },
  {
    exportName: "createTransportMonitorAdapterFromFile",
    rootModule: root,
    subpathModule: transport,
    subpathLabel: "@causal-order/monitor/transport",
  },
  {
    exportName: "TransportMonitorAdapter",
    rootModule: root,
    subpathModule: transport,
    subpathLabel: "@causal-order/monitor/transport",
  },
  {
    exportName: "monitorHarnessArtifacts",
    rootModule: root,
    subpathModule: testing,
    subpathLabel: "@causal-order/monitor/testing",
  },
  {
    exportName: "monitorHarnessScenarios",
    rootModule: root,
    subpathModule: testing,
    subpathLabel: "@causal-order/monitor/testing",
  },
];

for (const { exportName, rootModule, subpathModule, subpathLabel } of rootAndSubpathChecks) {
  assertOwnExport(rootModule, exportName, "@causal-order/monitor");
  assertOwnExport(subpathModule, exportName, subpathLabel);
}

assert.equal(typeof root.monitorPackageVersion, "string");
assert.equal(typeof root.monitorImplementationStatus, "string");
assert.equal(typeof root.createDefaultMonitorNow, "function");
assert.equal(typeof root.monitorHarnessArtifacts[Symbol.iterator], "function");
assert.equal(typeof root.monitorHarnessScenarios[Symbol.iterator], "function");
assertOwnExport(root, "HealthTracker", "@causal-order/monitor");
assertOwnExport(root, "ReplayCoordinator", "@causal-order/monitor");
assertOwnExport(root, "DeliveryRouter", "@causal-order/monitor");
assertOwnExport(root, "SQLiteReservoir", "@causal-order/monitor");
assertOwnExport(root, "ThrottleController", "@causal-order/monitor");
assertOwnExport(root, "TransportMonitorAdapter", "@causal-order/monitor");
assertOwnExport(root, "ReplayOwnershipError", "@causal-order/monitor");
for (const exportName of [
  "MonitorAdmissionRefusedError",
  "MonitorBoundaryError",
  "MonitorClosedError",
  "MonitorIndeterminateOutcomeError",
  "classifyMonitorBoundaryFailure",
  "deriveMonitorAdmissionDecision",
]) {
  assertOwnExport(root, exportName, "@causal-order/monitor");
}

for (const exportName of [
  "MONITOR_SQLITE_SCHEMA_VERSION",
  "MonitorSchemaCompatibilityError",
  "MonitorSchemaError",
  "MonitorSchemaMigrationError",
  "MonitorSchemaVersionError",
]) {
  assertOwnExport(storage, exportName, "@causal-order/monitor/storage");
}
assert.equal(storage.MONITOR_SQLITE_SCHEMA_VERSION, 2);

assert.ok(
  packageJson.exports["./replay"]?.types,
  "the replay subpath should publish a types target for ReplayBatch",
);
assert.ok(
  packageJson.exports["./storage"]?.types,
  "the storage subpath should publish a types target for ReservoirReplayEntry",
);
assert.ok(
  packageJson.exports["./transport"]?.types,
  "the transport subpath should publish a types target for transport helper types",
);
assert.ok(
  packageJson.exports["./testing"]?.types,
  "the testing subpath should publish a types target for harness metadata exports",
);
assert.ok(
  packageJson.exports["./types"]?.types,
  "the types subpath should publish a types target for public type-only exports",
);

assert.ok(
  Object.keys(types).length >= 0,
  "@causal-order/monitor/types should resolve even though its named exports are type-only at runtime",
);

console.log(
  "export contract passed: root-only exports, first-wave deprecated root exports, published subpaths, and packaged import/types targets all resolve as expected",
);

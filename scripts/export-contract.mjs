import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

for (const exportName of rootOnlyExports) {
  assertOwnExport(root, exportName, "@causal-order/monitor");
}

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
    exportName: "HealthTracker",
    rootModule: root,
    subpathModule: health,
    subpathLabel: "@causal-order/monitor/health",
  },
  {
    exportName: "ReplayCoordinator",
    rootModule: root,
    subpathModule: replay,
    subpathLabel: "@causal-order/monitor/replay",
  },
  {
    exportName: "DeliveryRouter",
    rootModule: root,
    subpathModule: routing,
    subpathLabel: "@causal-order/monitor/routing",
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
    exportName: "ThrottleController",
    rootModule: root,
    subpathModule: throttle,
    subpathLabel: "@causal-order/monitor/throttle",
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
assertOwnExport(root, "ReplayCoordinator", "@causal-order/monitor");
assertOwnExport(root, "SQLiteReservoir", "@causal-order/monitor");
assertOwnExport(root, "TransportMonitorAdapter", "@causal-order/monitor");
assertOwnExport(root, "ReplayOwnershipError", "@causal-order/monitor");

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
  "export contract passed: root-only exports, published subpaths, and packaged import/types targets all resolve as expected",
);

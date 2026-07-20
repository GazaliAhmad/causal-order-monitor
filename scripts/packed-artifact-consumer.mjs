import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath = process.env.npm_execpath;

function parseArguments(args) {
  const options = {
    tarball: null,
    packDestination: null,
    keepWorkspace: false,
    preferOnline: false,
    transportVersion: null,
    dedupeVersion: null,
    causalOrderVersion: null,
    testingVersion: null,
    typesNodeVersion: null,
    typescriptVersion: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-workspace") {
      options.keepWorkspace = true;
      continue;
    }
    if (argument === "--prefer-online") {
      options.preferOnline = true;
      continue;
    }

    const optionNames = new Map([
      ["--tarball", "tarball"],
      ["--pack-destination", "packDestination"],
      ["--transport-version", "transportVersion"],
      ["--dedupe-version", "dedupeVersion"],
      ["--causal-order-version", "causalOrderVersion"],
      ["--testing-version", "testingVersion"],
      ["--types-node-version", "typesNodeVersion"],
      ["--typescript-version", "typescriptVersion"],
    ]);
    const property = optionNames.get(argument);
    if (!property) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    options[property] = value;
    index += 1;
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}.`,
    );
  }
  return result.stdout ?? "";
}

function runNpm(args, options = {}) {
  assert.ok(
    npmCliPath,
    "Run this contract through npm run test:packed-artifact-consumer so npm_execpath is available.",
  );
  return run(process.execPath, [npmCliPath, ...args], options);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvedVersion(lockfile, packageName) {
  const entry = lockfile.packages[`node_modules/${packageName}`];
  assert.ok(entry?.version, `${packageName} should have an exact lockfile version`);
  return entry.version;
}

function hashFile(path, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function isWithin(parentPath, candidatePath) {
  const child = relative(parentPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function parsePackOutput(output) {
  const trimmed = output.trim();
  const firstBracket = trimmed.indexOf("[");
  assert.notEqual(firstBracket, -1, "npm pack --json should return JSON output");
  const parsed = JSON.parse(trimmed.slice(firstBracket));
  assert.equal(parsed.length, 1, "npm pack should produce exactly one artifact");
  return parsed[0];
}

function createTarball(workspace, suppliedTarball, suppliedPackDestination) {
  assert.ok(
    !(suppliedTarball && suppliedPackDestination),
    "--tarball and --pack-destination cannot be used together",
  );
  if (suppliedTarball) {
    const tarballPath = realpathSync(resolve(repositoryRoot, suppliedTarball));
    assert.ok(statSync(tarballPath).isFile(), "supplied tarball should be a file");
    return {
      path: tarballPath,
      filename: basename(tarballPath),
      size: statSync(tarballPath).size,
      shasum: hashFile(tarballPath, "sha1"),
      integrity: `sha512-${hashFile(tarballPath, "sha512", "base64")}`,
      entryCount: null,
      unpackedSize: null,
    };
  }

  const artifactDirectory = suppliedPackDestination
    ? resolve(repositoryRoot, suppliedPackDestination)
    : join(workspace, "artifact");
  mkdirSync(artifactDirectory, { recursive: true });
  const cacheDirectory = resolve(repositoryRoot, ".local/npm-cache");
  const output = runNpm(
    [
      "pack",
      "--json",
      "--dry-run=false",
      "--pack-destination",
      artifactDirectory,
      "--cache",
      cacheDirectory,
    ],
    { capture: true },
  );
  const packed = parsePackOutput(output);
  const tarballPath = resolve(artifactDirectory, packed.filename);
  assert.ok(statSync(tarballPath).isFile(), "npm pack should create the reported tarball");
  assert.equal(hashFile(tarballPath, "sha1"), packed.shasum, "tarball SHA-1");
  assert.equal(
    `sha512-${hashFile(tarballPath, "sha512", "base64")}`,
    packed.integrity,
    "tarball integrity",
  );
  return { path: tarballPath, ...packed };
}

function createConsumerFiles(consumerDirectory, packageJson, versions, tarballPath) {
  const tarballSpecifier = pathToFileURL(tarballPath).href;
  writeJson(join(consumerDirectory, "package.json"), {
    name: "causal-order-monitor-packed-artifact-consumer",
    private: true,
    type: "module",
    scripts: {
      check: "tsc -p tsconfig.json --noEmit",
      verify: "node verify-runtime.mjs",
    },
    dependencies: {
      "@causal-order/dedupe": versions.dedupe,
      "@causal-order/monitor": tarballSpecifier,
      "@causal-order/testing": versions.testing,
      "@causal-order/transport": versions.transport,
      "causal-order": versions.causalOrder,
    },
    devDependencies: {
      "@types/node": versions.typesNode,
      typescript: versions.typescript,
    },
  });

  writeJson(join(consumerDirectory, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      verbatimModuleSyntax: true,
    },
    include: ["verify-types.ts"],
  });

  writeFileSync(
    join(consumerDirectory, "verify-types.ts"),
    `import {
  createDefaultMonitorConfig,
  MONITOR_LIFECYCLE_EVENT_NAMES,
  MonitorCapacityRefusedError,
  monitorPackageVersion,
  type MonitorCapacitySnapshotV1,
  type MonitorLifecycleEvent,
  type MonitorLifecycleSnapshotV1,
  type MonitorOperatorSnapshotV1,
} from "@causal-order/monitor";
import {
  createDefaultMonitorNow,
  type MonitorConfig,
} from "@causal-order/monitor/config";
import { HealthTracker } from "@causal-order/monitor/health";
import {
  inspectMonitorSnapshotV1,
} from "@causal-order/monitor/inspect";
import {
  ReplayCoordinator,
  type ReplayBatch,
} from "@causal-order/monitor/replay";
import { DeliveryRouter } from "@causal-order/monitor/routing";
import {
  MonitorRuntime,
  type MonitorBoundaryFailure,
} from "@causal-order/monitor/runtime";
import {
  MONITOR_SQLITE_SCHEMA_VERSION,
  SQLiteReservoir,
  type MonitorSchemaInfo,
} from "@causal-order/monitor/storage";
import {
  monitorHarnessScenarios,
  type MonitorHarnessScenarioId,
} from "@causal-order/monitor/testing";
import {
  ThrottleController,
  type ThrottleDecision,
} from "@causal-order/monitor/throttle";
import {
  TransportMonitorAdapter,
  type MonitorIngestResult,
} from "@causal-order/monitor/transport";
import { MonitorScheduler } from "@causal-order/monitor/scheduler";
import type {
  MonitorIngressEvent,
  MonitorSnapshot,
} from "@causal-order/monitor/types";
import {
  createEventId,
  type NormalizedTransportEvent,
} from "@causal-order/transport";
import {
  DedupeGateway,
  type DedupeEvent,
} from "@causal-order/dedupe";
import {
  orderEvents,
  type EventEnvelope,
} from "causal-order";
import {
  harnessPipeline,
} from "@causal-order/testing/providers/default";
import type { HarnessPipelineProvider } from "@causal-order/testing";

const defaults: MonitorConfig = createDefaultMonitorConfig();
const now: bigint = createDefaultMonitorNow()();
const scenario: MonitorHarnessScenarioId = monitorHarnessScenarios[0].id;
const event: MonitorIngressEvent = {
  id: "packed-type-check",
  nodeId: "consumer",
  clock: { physicalTimeMs: now },
  payload: {},
};

type ContractTypes =
  | MonitorCapacitySnapshotV1
  | MonitorLifecycleEvent
  | MonitorLifecycleSnapshotV1
  | MonitorOperatorSnapshotV1
  | ReplayBatch
  | MonitorBoundaryFailure
  | MonitorSchemaInfo
  | ThrottleDecision
  | MonitorIngestResult
  | MonitorSnapshot
  | NormalizedTransportEvent
  | DedupeEvent
  | EventEnvelope;

const pipeline: HarnessPipelineProvider = harnessPipeline;

void defaults;
void scenario;
void event;
void (null as ContractTypes | null);
void MONITOR_LIFECYCLE_EVENT_NAMES;
void MonitorCapacityRefusedError;
void monitorPackageVersion;
void HealthTracker;
void inspectMonitorSnapshotV1;
void ReplayCoordinator;
void DeliveryRouter;
void MonitorRuntime;
void SQLiteReservoir;
void MONITOR_SQLITE_SCHEMA_VERSION;
void ThrottleController;
void TransportMonitorAdapter;
void MonitorScheduler;
void createEventId;
void DedupeGateway;
void orderEvents;
void pipeline;
`,
    "utf8",
  );

  const functionalSpecifiers = Object.keys(packageJson.exports)
    .filter((subpath) => subpath !== "./package.json")
    .map((subpath) => subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`);
  writeJson(join(consumerDirectory, "artifact-contract.json"), {
    packageName: packageJson.name,
    expectedVersion: packageJson.version,
    functionalSpecifiers,
    expectedExports: Object.keys(packageJson.exports),
  });

  writeFileSync(
    join(consumerDirectory, "verify-runtime.mjs"),
    `import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contract = JSON.parse(readFileSync(new URL("./artifact-contract.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const installedPackageJsonPath = require.resolve("@causal-order/monitor/package.json");
const packageRoot = realpathSync(resolve(installedPackageJsonPath, ".."));
const consumerRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const expectedNodeModulesRoot = realpathSync(resolve(consumerRoot, "node_modules"));

function isWithin(parentPath, candidatePath) {
  const child = relative(parentPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

assert.ok(isWithin(expectedNodeModulesRoot, packageRoot), "monitor should resolve inside the isolated consumer node_modules");
assert.equal(lstatSync(resolve(consumerRoot, "node_modules/@causal-order/monitor")).isSymbolicLink(), false, "monitor install should not be a workspace symlink");

const installedPackage = JSON.parse(readFileSync(installedPackageJsonPath, "utf8"));
assert.equal(installedPackage.name, contract.packageName);
assert.equal(installedPackage.version, contract.expectedVersion);
assert.deepEqual(Object.keys(installedPackage.exports).sort(), [...contract.expectedExports].sort());

const namespaces = new Map();
for (const specifier of contract.functionalSpecifiers) {
  const resolvedUrl = import.meta.resolve(specifier);
  const resolvedPath = realpathSync(fileURLToPath(resolvedUrl));
  assert.ok(isWithin(packageRoot, resolvedPath), specifier + " should resolve inside the installed monitor package");
  namespaces.set(specifier, await import(specifier));
}

assert.equal(namespaces.get("@causal-order/monitor").monitorPackageVersion, contract.expectedVersion);
assert.equal(namespaces.get("@causal-order/monitor").MONITOR_LIFECYCLE_EVENT_NAMES.length, 20);
assert.equal(typeof namespaces.get("@causal-order/monitor").MonitorCapacityRefusedError, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/config").createDefaultMonitorConfig, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/health").HealthTracker, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/inspect").inspectMonitorSnapshotV1, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/replay").ReplayCoordinator, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/routing").DeliveryRouter, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/runtime").MonitorRuntime, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/storage").SQLiteReservoir, "function");
assert.ok(Array.isArray(namespaces.get("@causal-order/monitor/testing").monitorHarnessScenarios));
assert.equal(typeof namespaces.get("@causal-order/monitor/throttle").ThrottleController, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/transport").TransportMonitorAdapter, "function");
assert.equal(typeof namespaces.get("@causal-order/monitor/scheduler").MonitorScheduler, "function");
assert.deepEqual(Object.keys(namespaces.get("@causal-order/monitor/types")), []);

const peerNamespaces = new Map();
for (const specifier of [
  "@causal-order/transport",
  "@causal-order/dedupe",
  "causal-order",
  "@causal-order/testing/providers/default",
]) {
  const resolvedUrl = import.meta.resolve(specifier);
  const resolvedPath = realpathSync(fileURLToPath(resolvedUrl));
  assert.ok(isWithin(expectedNodeModulesRoot, resolvedPath), specifier + " should resolve inside the isolated consumer node_modules");
  peerNamespaces.set(specifier, await import(specifier));
}

assert.equal(
  peerNamespaces.get("@causal-order/transport").createEventId("node-a", 1),
  "node-a-000000000001",
);
const gateway = new (peerNamespaces.get("@causal-order/dedupe").DedupeGateway)({ nowProvider: () => 1_000n });
assert.equal(gateway.filter({ id: "peer-matrix-event" }), true);
assert.equal(gateway.filter({ id: "peer-matrix-event" }), false);
gateway.destroy();
assert.equal(typeof peerNamespaces.get("causal-order").orderEvents, "function");
assert.equal(typeof peerNamespaces.get("@causal-order/testing/providers/default").harnessPipeline.createDedupeAdapter, "function");

for (const [subpath, target] of Object.entries(installedPackage.exports)) {
  if (typeof target === "string") {
    const targetPath = realpathSync(resolve(packageRoot, target));
    assert.ok(isWithin(packageRoot, targetPath), subpath + " target should remain inside package");
    continue;
  }
  for (const condition of ["types", "import"]) {
    if (!target[condition]) continue;
    const targetPath = realpathSync(resolve(packageRoot, target[condition]));
    assert.ok(isWithin(packageRoot, targetPath), subpath + " " + condition + " target should remain inside package");
  }
}

for (const forbidden of ["src", "scripts", ".github", ".local", "tsconfig.json", "tsconfig.build.json", "package-lock.json"]) {
  assert.equal(existsSync(resolve(packageRoot, forbidden)), false, forbidden + " should not be published");
}
for (const required of ["README.md", "CHANGELOG.md", "LICENSE", "docs", ".build/src/index.js", ".build/src/index.d.ts"]) {
  assert.equal(existsSync(resolve(packageRoot, required)), true, required + " should be published");
}

console.log("Packed artifact verified all monitor root/subpath imports, declarations, metadata, and isolation.");
`,
    "utf8",
  );
}

const options = parseArguments(process.argv.slice(2));
const rootPackage = readJson(join(repositoryRoot, "package.json"));
const rootLockfile = readJson(join(repositoryRoot, "package-lock.json"));
const workspace = mkdtempSync(join(tmpdir(), "causal-order-monitor-packed-consumer-"));
let completed = false;

try {
  const tarball = createTarball(
    workspace,
    options.tarball,
    options.packDestination,
  );
  const consumerDirectory = join(workspace, "consumer");
  mkdirSync(consumerDirectory, { recursive: true });
  const versions = {
    transport: options.transportVersion ?? resolvedVersion(rootLockfile, "@causal-order/transport"),
    dedupe: options.dedupeVersion ?? resolvedVersion(rootLockfile, "@causal-order/dedupe"),
    causalOrder: options.causalOrderVersion ?? resolvedVersion(rootLockfile, "causal-order"),
    testing: options.testingVersion ?? resolvedVersion(rootLockfile, "@causal-order/testing"),
    typesNode: options.typesNodeVersion ?? resolvedVersion(rootLockfile, "@types/node"),
    typescript: options.typescriptVersion ?? resolvedVersion(rootLockfile, "typescript"),
  };

  createConsumerFiles(consumerDirectory, rootPackage, versions, tarball.path);
  runNpm(
    [
      "install",
      "--dry-run=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      options.preferOnline ? "--prefer-online" : "--prefer-offline",
      "--cache",
      resolve(repositoryRoot, ".local/npm-cache"),
    ],
    { cwd: consumerDirectory },
  );

  const installedMonitorPath = join(
    consumerDirectory,
    "node_modules",
    "@causal-order",
    "monitor",
  );
  assert.equal(
    lstatSync(installedMonitorPath).isSymbolicLink(),
    false,
    "installed monitor should not be a symbolic workspace link",
  );
  assert.ok(
    isWithin(realpathSync(join(consumerDirectory, "node_modules")), realpathSync(installedMonitorPath)),
    "installed monitor should remain inside consumer node_modules",
  );

  runNpm(["run", "check"], { cwd: consumerDirectory });
  runNpm(["run", "verify"], { cwd: consumerDirectory });

  const installedLockfile = readJson(join(consumerDirectory, "package-lock.json"));
  const installedMonitor = installedLockfile.packages["node_modules/@causal-order/monitor"];
  assert.equal(installedMonitor.version, rootPackage.version, "installed monitor version");
  assert.equal(installedMonitor.integrity, tarball.integrity, "installed tarball integrity");
  const resolvedVersions = {
    transport: installedLockfile.packages["node_modules/@causal-order/transport"].version,
    dedupe: installedLockfile.packages["node_modules/@causal-order/dedupe"].version,
    causalOrder: installedLockfile.packages["node_modules/causal-order"].version,
    testing: installedLockfile.packages["node_modules/@causal-order/testing"].version,
    typesNode: installedLockfile.packages["node_modules/@types/node"].version,
    typescript: installedLockfile.packages["node_modules/typescript"].version,
  };

  console.log(JSON.stringify({
    artifact: {
      filename: tarball.filename,
      size: tarball.size,
      unpackedSize: tarball.unpackedSize,
      entryCount: tarball.entryCount,
      shasum: tarball.shasum,
      integrity: tarball.integrity,
    },
    consumer: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      requestedVersions: versions,
      resolvedVersions,
    },
  }, null, 2));
  completed = true;
} finally {
  if (options.keepWorkspace) {
    console.log(`Packed consumer workspace retained at ${workspace}`);
  } else {
    const resolvedWorkspace = realpathSync(workspace);
    assert.ok(
      isWithin(realpathSync(tmpdir()), resolvedWorkspace) &&
        basename(resolvedWorkspace).startsWith("causal-order-monitor-packed-consumer-"),
      "temporary consumer cleanup target should be scoped to the expected OS temp directory",
    );
    rmSync(resolvedWorkspace, { recursive: true, force: true });
  }
}

if (!completed) {
  process.exitCode = 1;
}

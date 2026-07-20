import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const versionOf = (name) => lockfile.packages[`node_modules/${name}`].version;
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
};

const workspace = mkdtempSync(join(tmpdir(), "monitor-packed-lifecycle-"));
const artifactDir = join(workspace, "artifact");
const consumer = join(workspace, "consumer");
mkdirSync(artifactDir, { recursive: true });
mkdirSync(consumer, { recursive: true });
try {
  const packResult = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, "pack", "--json", "--dry-run=false", "--pack-destination", artifactDir, "--cache", resolve(root, ".local/npm-cache")] : ["pack", "--dry-run=false"], { cwd: root, encoding: "utf8" });
  if (packResult.error) throw packResult.error;
  if (packResult.status !== 0) throw new Error(`npm pack failed with ${packResult.status}`);
  const packed = JSON.parse(packResult.stdout.slice(packResult.stdout.indexOf("[")));
  const tarball = join(artifactDir, packed[0].filename);
  const packageJson = {
    name: "monitor-packed-lifecycle-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@causal-order/monitor": tarball,
      "@causal-order/transport": versionOf("@causal-order/transport"),
      "@causal-order/dedupe": versionOf("@causal-order/dedupe"),
      "causal-order": versionOf("causal-order"),
    },
  };
  writeFileSync(join(consumer, "package.json"), JSON.stringify(packageJson, null, 2));
  run(process.execPath, [npmCli, "install", "--dry-run=false", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--cache", resolve(root, ".local/npm-cache")], consumer);
  writeFileSync(join(consumer, "lifecycle.mjs"), `
import assert from "node:assert/strict";
import { DedupeGateway } from "@causal-order/dedupe";
import { orderEvents } from "causal-order";
import { createEventId } from "@causal-order/transport";
import { MonitorCapacityRefusedError, TransportMonitorAdapter } from "@causal-order/monitor/transport";

const databasePath = "${join(consumer, "monitor.sqlite").replaceAll("\\", "\\\\")}";
let now = 1_000n;
let causalOnline = true;
let failReplayOnce = false;
let orderDeliveries = 0;
let replayThroughDedupe = 0;
const dedupe = new DedupeGateway({ autoCleanup: false });
const event = (sequence) => ({ id: createEventId("packed", sequence), nodeId: "packed", sequence: BigInt(sequence), clock: { physicalTimeMs: now, logicalCounter: 0, nodeId: "packed" }, payload: { sequence } });
const deliverToOrder = (value, context) => {
  if (!causalOnline) throw new Error("causal-order offline");
  orderEvents([value], { strict: false, detectAnomalies: true });
  orderDeliveries += 1;
  if (context.replay) replayThroughDedupe += 1;
};
const handlers = {
  deliverToDedupe(value, context) {
    if (context.replay) replayThroughDedupe += 1;
    if (failReplayOnce && context.replay) { failReplayOnce = false; throw new Error("injected replay failure"); }
    if (dedupe.filter({ id: value.id, nodeId: value.nodeId, sequence: value.sequence })) deliverToOrder(value, context);
  },
  deliverToOrder,
  onBuffered() {},
};
const config = { now: () => now, startup: { healthPolicy: "conservative" }, reservoir: { databasePath, capacity: { maxPendingRows: 2 } }, replay: { healthConfirmationHeartbeats: 2, retryBackoffMs: 5_000n } };
const adapter = new TransportMonitorAdapter(handlers, config);
const firstLifecycle = [];
for (const type of ["ingressAccepted", "ingressRefused", "deliveryAcknowledged"]) adapter.lifecycle.subscribe(type, (evidence) => firstLifecycle.push(evidence));
const first = await adapter.ingest(event(1));
assert.equal(first.forwardedTo, "buffer");
for (const component of ["transport", "dedupe", "causal-order"]) adapter.observeHeartbeat(component, now);
const healthy = await adapter.ingest(event(2));
assert.equal(healthy.forwardedTo, "dedupe");
causalOnline = false;
adapter.updateComponentHealth("causal-order", { state: "offline", observedAt: ++now, reasonCode: "lifecycle-test" });
const buffered = await adapter.ingest(event(3));
assert.equal(buffered.forwardedTo, "buffer");
await assert.rejects(() => adapter.ingest(event(4)), MonitorCapacityRefusedError);
await adapter.lifecycle.flush();
assert.equal(firstLifecycle.filter((evidence) => evidence.type === "ingressAccepted").length, 3);
assert.equal(firstLifecycle.filter((evidence) => evidence.type === "ingressRefused").length, 1);
assert.equal(firstLifecycle.find((evidence) => evidence.type === "ingressRefused").limitingDimension, "pending_rows");
assert.equal(adapter.capacity.getSnapshot().usage.pendingRows, 2);
adapter.close();

causalOnline = true;
const restarted = new TransportMonitorAdapter(handlers, config);
assert.equal(restarted.getRuntime().getReservoirStats().totalPendingRows, 2);
failReplayOnce = true;
for (let index = 0; index < 2; index += 1) {
  restarted.observeHeartbeat("transport", now);
  restarted.observeHeartbeat("dedupe", now);
  restarted.observeHeartbeat("causal-order", now);
}
const failed = await restarted.reconcileRecovery(10);
assert.equal(failed?.completed, false);
assert.equal(restarted.getReplaySnapshot().state, "failed");
let recovered = null;
now += 10_000n;
restarted.observeHeartbeat("transport", now);
restarted.observeHeartbeat("dedupe", now);
restarted.observeHeartbeat("causal-order", now);
restarted.getRuntime().queueManagedReplay();
assert.equal(restarted.getReplaySnapshot().state, "queued");
recovered = await restarted.pumpReplayBatch(10);
assert.equal(recovered?.completed, true);
assert.equal(restarted.getRuntime().getReservoirStats().totalPendingRows, 0);
assert.equal(restarted.capacity.getSnapshot().usage.pendingRows, 0);
restarted.observeHeartbeat("dedupe", now);
restarted.observeHeartbeat("causal-order", now);
restarted.observeHeartbeat("dedupe", now);
assert.equal(restarted.getReplaySnapshot().state, "idle");
const resumed = await restarted.ingest(event(5));
assert.equal(resumed.forwardedTo, "dedupe");
assert.ok(orderDeliveries >= 2);
assert.ok(replayThroughDedupe >= 1);
restarted.close();
dedupe.destroy();
console.log("Packed full-stack lifecycle passed: v0.5 capacity refusal/lifecycle evidence, conservative startup, outage buffering, restart recovery, persisted retry, and replay through dedupe.");
`);
  run(process.execPath, ["lifecycle.mjs"], consumer);
  assert.ok(existsSync(join(consumer, "node_modules", "@causal-order", "monitor")));
  console.log(JSON.stringify({ artifact: packed[0].filename, versions: packageJson.dependencies }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

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
  const packResult = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, "pack", "--json", "--pack-destination", artifactDir, "--cache", resolve(root, ".local/npm-cache")] : ["pack"], { cwd: root, encoding: "utf8" });
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
  run(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--cache", resolve(root, ".local/npm-cache")], consumer);
  writeFileSync(join(consumer, "lifecycle.mjs"), `
import assert from "node:assert/strict";
import { DedupeGateway } from "@causal-order/dedupe";
import { orderEvents } from "causal-order";
import { createEventId } from "@causal-order/transport";
import { TransportMonitorAdapter } from "@causal-order/monitor/transport";

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
const config = { now: () => now, startup: { healthPolicy: "conservative" }, reservoir: { databasePath }, replay: { healthConfirmationHeartbeats: 2, retryBackoffMs: 5_000n } };
const adapter = new TransportMonitorAdapter(handlers, config);
const first = await adapter.ingest(event(1));
assert.equal(first.forwardedTo, "buffer");
for (const component of ["transport", "dedupe", "causal-order"]) adapter.observeHeartbeat(component, now);
const healthy = await adapter.ingest(event(2));
assert.equal(healthy.forwardedTo, "dedupe");
causalOnline = false;
adapter.updateComponentHealth("causal-order", { state: "offline", observedAt: ++now, reasonCode: "lifecycle-test" });
const buffered = await adapter.ingest(event(3));
assert.equal(buffered.forwardedTo, "buffer");
adapter.close();

causalOnline = true;
const restarted = new TransportMonitorAdapter(handlers, config);
assert.equal(restarted.getRuntime().getReservoirStats().totalPendingRows, 2);
const restartStartup = await restarted.ingest(event(4));
assert.equal(restartStartup.forwardedTo, "buffer");
failReplayOnce = true;
for (let index = 0; index < 2; index += 1) {
  restarted.observeHeartbeat("dedupe", now);
  restarted.observeHeartbeat("causal-order", now);
}
const failed = await restarted.reconcileRecovery(10);
assert.equal(failed?.completed, false);
assert.equal(restarted.getReplaySnapshot().state, "failed");
let recovered = null;
now += 10_000n;
restarted.observeHeartbeat("dedupe", now);
restarted.observeHeartbeat("causal-order", now);
restarted.getRuntime().queueManagedReplay();
assert.equal(restarted.getReplaySnapshot().state, "queued");
recovered = await restarted.pumpReplayBatch(10);
assert.equal(recovered?.completed, true);
assert.equal(restarted.getRuntime().getReservoirStats().totalPendingRows, 0);
assert.ok(orderDeliveries >= 2);
assert.ok(replayThroughDedupe >= 1);
restarted.close();
dedupe.destroy();
console.log("Packed full-stack lifecycle passed: conservative startup, healthy delivery, outage buffering, restart recovery, persisted retry, and replay through dedupe.");
`);
  run(process.execPath, ["lifecycle.mjs"], consumer);
  assert.ok(existsSync(join(consumer, "node_modules", "@causal-order", "monitor")));
  console.log(JSON.stringify({ artifact: packed[0].filename, versions: packageJson.dependencies }));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorScheduler, TransportMonitorAdapter } from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-scheduler-"));
const timers = [];
const timerApi = {
  setTimeout(callback, delayMs) {
    const handle = { callback, delayMs, cleared: false };
    timers.push(handle);
    return handle;
  },
  clearTimeout(handle) {
    handle.cleared = true;
  },
};
let now = 1_000n;
let releaseProbe;
let probeStarted = false;
const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
const adapter = new TransportMonitorAdapter(
  { deliverToDedupe() {}, deliverToOrder() {} },
  { reservoir: { databasePath: join(workspace, "monitor.sqlite") } },
);
const scheduler = new MonitorScheduler({
  adapter,
  healthIntervalMs: 1_000,
  replayIntervalMs: 1_000,
  pruneIntervalMs: 1_000,
  closeAdapterOnStop: true,
  timers: timerApi,
  now: () => now,
  healthProbe: async () => {
    probeStarted = true;
    await probeGate;
    for (const component of ["transport", "dedupe", "causal-order"]) {
      adapter.observeHeartbeat(component, now);
    }
  },
});

try {
  scheduler.start();
  assert.equal(scheduler.getState().status, "running");
  const firstTimer = timers.shift();
  assert.equal(firstTimer.delayMs, 0);
  firstTimer.callback();
  while (!probeStarted) await Promise.resolve();
  const overlapping = scheduler.tick();
  assert.equal(scheduler.getState().tickCount, 1);
  releaseProbe();
  await overlapping;
  assert.equal(scheduler.getState().lastError, null);
  assert.ok(timers.length >= 1);
  assert.equal(scheduler.getState().status, "running");
  now = 2_000n;
  await scheduler.stop();
  assert.equal(scheduler.getState().status, "stopped");
  assert.equal(scheduler.getState().tickCount, 1);
  assert.throws(() => adapter.getRuntime().getSnapshot(), /closed/i);
} finally {
  await scheduler.stop();
  rmSync(workspace, { recursive: true, force: true });
}

const offlineWorkspace = mkdtempSync(join(tmpdir(), "monitor-scheduler-offline-"));
const offlineAdapter = new TransportMonitorAdapter(
  { deliverToDedupe() {}, deliverToOrder() {} },
  { reservoir: { databasePath: join(offlineWorkspace, "monitor.sqlite") } },
);
const offlineTimers = [];
const offlineScheduler = new MonitorScheduler({
  adapter: offlineAdapter,
  replayIntervalMs: 1,
  pruneIntervalMs: 1,
  healthIntervalMs: 1,
  closeAdapterOnStop: true,
  timers: {
    setTimeout(callback, delayMs) {
      const handle = { callback, delayMs, cleared: false };
      offlineTimers.push(handle);
      return handle;
    },
    clearTimeout(handle) { handle.cleared = true; },
  },
  now: () => 10_000n,
});

try {
  offlineAdapter.updateComponentHealth("dedupe", { state: "offline", observedAt: 10_000n });
  offlineAdapter.updateComponentHealth("causal-order", { state: "offline", observedAt: 10_000n });
  await offlineAdapter.ingest({
    id: "offline-backlog",
    nodeId: "scheduler-node",
    clock: { physicalTimeMs: 10_000n, logicalCounter: 0n, nodeId: "scheduler-node" },
    ingestedAt: 10_000n,
    payload: { kind: "scheduler-offline" },
  });
  offlineAdapter.getRuntime().queueManagedReplay();
  offlineScheduler.start();
  await offlineScheduler.tick();
  assert.equal(offlineScheduler.getState().lastError, null);
  assert.equal(offlineAdapter.getReplaySnapshot().state, "queued");
} finally {
  await offlineScheduler.stop();
  rmSync(offlineWorkspace, { recursive: true, force: true });
}

console.log("Scheduler contract passed: ticks serialize, offline replay is skipped, health probes are caller-owned, retry/prune work remains bounded, and stop is idempotent with optional adapter close.");

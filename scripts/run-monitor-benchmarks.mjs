import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createDefaultMonitorConfig,
  MonitorCapacityRefusedError,
  MonitorRuntime,
  MonitorScheduler,
} from "../.build/src/index.js";
import { LifecycleDispatcher } from "../.build/src/lifecycle/LifecycleDispatcher.js";
import { SQLiteReservoir } from "../.build/src/storage.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const profile = args.profile ?? "baseline";
assert.ok(["ci", "baseline"].includes(profile), "--profile must be ci or baseline");
const settings = profile === "ci"
  ? { warmup: 0, iterations: 2, events: 24, batchSize: 8, payloadBytes: 128 }
  : { warmup: 1, iterations: 5, events: 200, batchSize: 32, payloadBytes: 256 };
for (const key of ["warmup", "iterations", "events", "batchSize", "payloadBytes"]) {
  if (args[key] !== undefined) settings[key] = positiveInteger(args[key], key, key === "warmup");
}
const outputPath = resolve(
  ROOT,
  args.output ?? `artifacts/validation/monitor-v0.5.0-performance-${profile}.json`,
);
const summaryOutputPath = args.summaryOutput ? resolve(ROOT, args.summaryOutput) : null;
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const workspace = mkdtempSync(join(tmpdir(), "monitor-benchmark-"));
const cases = [];

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    assert.ok(token.startsWith("--"), `Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[index + 1];
    assert.ok(value && !value.startsWith("--"), `Missing value for ${token}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0), `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return parsed;
}

function event(id, at = 1_000n) {
  return {
    id,
    nodeId: "benchmark-node",
    clock: { physicalTimeMs: at, logicalCounter: 0n, nodeId: "benchmark-node" },
    sequence: BigInt(id.replace(/\D/g, "") || 0),
    traceId: `trace-${id}`,
    ingestedAt: at,
    payload: { kind: "benchmark", body: "x".repeat(settings.payloadBytes), entityId: id },
  };
}

function dbPath(label, sample) {
  return join(workspace, `${label}-${sample}.sqlite`);
}

function summarize(samples) {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const rates = samples.map((sample) => sample.operations / (sample.durationMs / 1_000)).sort((a, b) => a - b);
  const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
  return {
    sampleCount: samples.length,
    durationMs: {
      median: round(percentile(durations, 0.5)),
      p95: round(percentile(durations, 0.95)),
      minimum: round(durations[0]),
      maximum: round(durations.at(-1)),
    },
    operationsPerSecond: {
      median: round(percentile(rates, 0.5)),
      p05: round(percentile(rates, 0.05)),
    },
  };
}

function round(value) {
  return Number(value.toFixed(3));
}

function containsPayloadField(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && Object.hasOwn(value, "payload")) return true;
  return Object.values(value).some((nested) => containsPayloadField(nested, seen));
}

async function measure(family, name, workload, details = {}) {
  const samples = [];
  let evidence;
  for (let index = -settings.warmup; index < settings.iterations; index += 1) {
    const started = performance.now();
    const result = await workload(index);
    const durationMs = Math.max(result.durationMs ?? performance.now() - started, 0.001);
    assert.ok(result && Number.isSafeInteger(result.operations) && result.operations > 0);
    if (index >= 0) samples.push({ durationMs: round(durationMs), operations: result.operations });
    evidence = result.evidence;
  }
  cases.push({
    family,
    name,
    correctness: "passed",
    workload: details,
    samples,
    summary: summarize(samples),
    evidence,
  });
  console.log(`${family}/${name}: correctness passed; median ${cases.at(-1).summary.durationMs.median} ms`);
}

async function ingressCase(name, capacity) {
  await measure("ingress", name, (sample) => {
    const runtime = new MonitorRuntime({
      reservoir: { databasePath: dbPath(`ingress-${name}`, sample), capacity },
      lifecycle: { queueCapacity: Math.max(64, settings.events * 4) },
    });
    try {
      const started = performance.now();
      for (let index = 0; index < settings.events; index += 1) {
        const accepted = runtime.ingestTransportEvent(event(`${name}-${sample}-${index}`));
        assert.equal(runtime.acknowledgeIngressDelivery([accepted.rowId]), 1);
      }
      const durationMs = performance.now() - started;
      const stats = runtime.getReservoirStats();
      assert.equal(stats.totalPendingRows, 0);
      assert.equal(runtime.capacity.getSnapshot().counters.refusedTotal, 0);
      return { durationMs, operations: settings.events, evidence: { pendingRows: stats.totalPendingRows, refused: 0 } };
    } finally {
      runtime.close();
    }
  }, { eventsPerSample: settings.events, capacity });
}

async function saturatedRefusal() {
  await measure("ingress", "saturated-refusal", (sample) => {
    const runtime = new MonitorRuntime({
      reservoir: {
        databasePath: dbPath("saturated", sample),
        capacity: { ...createDefaultMonitorConfig().reservoir.capacity, maxPendingRows: 1 },
      },
      lifecycle: { queueCapacity: Math.max(64, settings.events * 4) },
    });
    try {
      runtime.ingestTransportEvent(event(`saturated-seed-${sample}`));
      const started = performance.now();
      for (let index = 0; index < settings.events; index += 1) {
        assert.throws(
          () => runtime.ingestTransportEvent(event(`refused-${sample}-${index}`)),
          (error) => error instanceof MonitorCapacityRefusedError && error.limitingDimension === "pending_rows",
        );
      }
      const durationMs = performance.now() - started;
      const snapshot = runtime.capacity.getSnapshot();
      assert.equal(runtime.getReservoirStats().totalPendingRows, 1);
      assert.equal(snapshot.counters.refusedTotal, settings.events);
      return { durationMs, operations: settings.events, evidence: { pendingRows: 1, refused: snapshot.counters.refusedTotal } };
    } finally {
      runtime.close();
    }
  }, { attemptsPerSample: settings.events, maxPendingRows: 1 });
}

async function replayCase() {
  await measure("replay", "claim-deliver-ack-final-drain", (sample) => {
    const runtime = new MonitorRuntime({
      reservoir: { databasePath: dbPath("replay", sample) },
      lifecycle: { queueCapacity: Math.max(64, settings.events * 6) },
    });
    try {
      for (let index = 0; index < settings.events; index += 1) runtime.ingestTransportEvent(event(`replay-${sample}-${index}`));
      runtime.queueReplay();
      const started = performance.now();
      let delivered = 0;
      while (runtime.getReservoirStats().totalPendingRows > 0) {
        const batch = runtime.claimReplayBatch(settings.batchSize);
        assert.ok(batch.entries.length > 0 && batch.entries.length <= settings.batchSize);
        runtime.acknowledgeReplayBatch(batch.entries.map((entry) => entry.rowId));
        delivered += batch.entries.length;
      }
      const durationMs = performance.now() - started;
      assert.equal(delivered, settings.events);
      assert.equal(runtime.getReservoirStats().totalPendingRows, 0);
      assert.equal(runtime.getReservoirLifecycleStats().deliveredRows, settings.events);
      return { durationMs, operations: delivered, evidence: { delivered, finalPendingRows: 0, batchSize: settings.batchSize } };
    } finally {
      runtime.close();
    }
  }, { backlogRows: settings.events, batchSize: settings.batchSize });
}

async function pruneCase(name, terminal) {
  await measure("prune", name, (sample) => {
    let now = 0n;
    const reservoir = new SQLiteReservoir({
      ...createDefaultMonitorConfig().reservoir,
      databasePath: dbPath(`prune-${name}`, sample),
      rollingBufferWindowMs: 100n,
      fullOutageMaxWindowMs: 100n,
      deliveredRetentionMs: 100n,
      deadLetterRetentionMs: 200n,
      pruneBatchSize: settings.batchSize,
    }, () => now);
    try {
      for (let index = 0; index < settings.events; index += 1) {
        reservoir.appendIngressEvent(event(`prune-${name}-${sample}-${index}`, 0n), {
          sourcePath: terminal ? "deduped_observation" : "transport_normalized_stream",
          deliveryMode: terminal ? "normal" : "order_buffer_only",
          replayState: terminal ? "delivered" : "pending",
        });
      }
      now = 500n;
      const started = performance.now();
      let affected = 0;
      let calls = 0;
      while (affected < settings.events) {
        const result = reservoir.pruneExpired(false);
        const current = terminal ? result.deletedRows : result.markedDeadLetter;
        assert.ok(current > 0 && current <= settings.batchSize);
        affected += current;
        calls += 1;
      }
      const durationMs = performance.now() - started;
      assert.equal(affected, settings.events);
      assert.equal(reservoir.getStats().totalPendingRows, 0);
      return { durationMs, operations: affected, evidence: { affected, calls, bound: settings.batchSize } };
    } finally {
      reservoir.close();
    }
  }, { rowsPerSample: settings.events, pruneBatchSize: settings.batchSize });
}

async function startupCases() {
  await measure("startup", "fresh", (sample) => {
    const started = performance.now();
    const runtime = new MonitorRuntime({ reservoir: { databasePath: dbPath("fresh", sample) } });
    const durationMs = performance.now() - started;
    try {
      assert.equal(runtime.getSchemaInfo().currentVersion, 3);
      return { durationMs, operations: 1, evidence: { schemaVersion: 3, pendingRows: 0 } };
    } finally { runtime.close(); }
  }, { databaseState: "absent" });

  await measure("startup", "restart-with-backlog", (sample) => {
    const path = dbPath("restart", sample);
    const original = new MonitorRuntime({ reservoir: { databasePath: path } });
    for (let index = 0; index < settings.events; index += 1) original.ingestTransportEvent(event(`restart-${sample}-${index}`));
    original.close();
    const started = performance.now();
    const restarted = new MonitorRuntime({ reservoir: { databasePath: path } });
    const durationMs = performance.now() - started;
    try {
      assert.equal(restarted.getReservoirStats().totalPendingRows, settings.events);
      assert.equal(restarted.needsRecoveryReplay(), true);
      return { durationMs, operations: 1, evidence: { recoveredPendingRows: settings.events, recoveryRequired: true } };
    } finally { restarted.close(); }
  }, { backlogRows: settings.events });
}

async function inspectionCase() {
  for (const [name, inspect] of [
    ["raw", (runtime) => runtime.getSnapshot()],
    ["inspected", (runtime) => runtime.getInspectedSnapshot()],
    ["operator-v1", (runtime) => runtime.getOperatorSnapshot()],
  ]) {
    await measure("inspection", name, (sample) => {
      const runtime = new MonitorRuntime({ reservoir: { databasePath: dbPath(`inspect-${name}`, sample) } });
      try {
        for (let index = 0; index < settings.events; index += 1) runtime.ingestTransportEvent(event(`inspect-${name}-${sample}-${index}`));
        let snapshot;
        const started = performance.now();
        for (let index = 0; index < settings.events; index += 1) snapshot = inspect(runtime);
        const durationMs = performance.now() - started;
        assert.equal(runtime.getReservoirStats().totalPendingRows, settings.events);
        if (name === "operator-v1") {
          assert.equal(snapshot.schema, "causal-order-monitor/operator-snapshot");
          assert.equal(snapshot.version, 1);
          assert.doesNotThrow(() => JSON.stringify(snapshot));
        }
        assert.equal(containsPayloadField(snapshot), false);
        return { durationMs, operations: settings.events, evidence: { inspection: name, backlogRows: settings.events } };
      } finally { runtime.close(); }
    }, { inspectionsPerSample: settings.events, backlogRows: settings.events });
  }
}

async function schedulerCase() {
  await measure("scheduler", "pacing-coalescing-retry-shutdown", async () => {
    let now = 1_000n;
    let health = 0;
    let replay = 0;
    let prune = 0;
    let close = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseReplay;
    const gate = new Promise((resolve) => { releaseReplay = resolve; });
    const timers = [];
    const timerApi = {
      setTimeout(callback, delayMs) { const handle = { callback, delayMs, cleared: false }; timers.push(handle); return handle; },
      clearTimeout(handle) { handle.cleared = true; },
    };
    const fakeAdapter = {
      lifecycle: { publish() { return true; } },
      async reconcileRecovery() {
        replay += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (replay === 1) await gate;
        active -= 1;
      },
      getRuntime() {
        return {
          getHealthSnapshot() {
            return { dedupe: { state: "online" }, "causal-order": { state: "online" } };
          },
          pruneReservoir() { prune += 1; },
        };
      },
      getReplaySnapshot() { return { nextRetryAt: now + 37n }; },
      close() { close += 1; },
    };
    const scheduler = new MonitorScheduler({
      adapter: fakeAdapter,
      healthProbe() { health += 1; },
      healthIntervalMs: 20,
      replayIntervalMs: 10,
      pruneIntervalMs: 30,
      closeAdapterOnStop: true,
      timers: timerApi,
      now: () => now,
    });
    scheduler.start();
    const initialTimer = timers.shift();
    assert.equal(initialTimer.delayMs, 0);
    initialTimer.callback();
    await Promise.resolve();
    const first = scheduler.tick();
    const overlapping = scheduler.tick();
    assert.equal(scheduler.getState().tickCount, 1);
    releaseReplay();
    await Promise.all([first, overlapping]);
    assert.equal(maximumActive, 1);
    assert.equal(health, 1);
    assert.equal(prune, 1);
    await Promise.resolve();
    await Promise.resolve();
    const retryTimer = timers.shift();
    assert.equal(retryTimer.delayMs, 37);
    now += 37n;
    retryTimer.callback();
    await scheduler.tick();
    assert.equal(scheduler.getState().tickCount, 2);
    assert.equal(maximumActive, 1);
    await scheduler.stop();
    assert.equal(close, 1);
    assert.equal(scheduler.getState().status, "stopped");
    return {
      operations: 2,
      evidence: { maximumInFlightReplay: maximumActive, configuredIntervalsMs: { health: 20, replay: 10, prune: 30 }, retryDeadlineDelayMs: 37, healthRuns: health, replayRuns: replay, pruneRuns: prune, adapterCloseCount: close },
    };
  }, { ticksPerSample: 2, concurrentTickRequests: 2, retryDeadlineDelayMs: 37 });
}

function lifecycleEvent(index) {
  return { type: "ingressAttempted", occurredAtMs: String(index), eventId: `lifecycle-${index}` };
}

async function lifecycleCase(name) {
  await measure("lifecycle", name, async () => {
    const queueCapacity = name === "controlled-overflow" ? Math.max(2, Math.floor(settings.events / 4)) : settings.events + 2;
    const dispatcher = new LifecycleDispatcher({ queueCapacity, overflowPolicy: "drop_oldest", shutdownFlushTimeoutMs: 10_000n }, () => 99n);
    let received = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    if (name !== "no-listener") {
      dispatcher.subscribe("ingressAttempted", async () => {
        received += 1;
        if ((name === "slow-listener" || name === "controlled-overflow") && received === 1) await gate;
      });
    }
    const started = performance.now();
    for (let index = 0; index < settings.events; index += 1) dispatcher.publish(lifecycleEvent(index));
    if (name === "slow-listener" || name === "controlled-overflow") {
      await Promise.resolve();
      release();
    }
    const flushed = await dispatcher.flush();
    const durationMs = performance.now() - started;
    const snapshot = dispatcher.getSnapshot();
    assert.equal(flushed.status, "drained");
    assert.equal(snapshot.queueDepth, 0);
    if (name === "no-listener") assert.equal(received, 0);
    if (name === "fast-listener" || name === "slow-listener") {
      assert.equal(received, settings.events);
      assert.equal(snapshot.droppedTotal, 0);
    }
    if (name === "controlled-overflow") {
      assert.ok(snapshot.droppedTotal > 0);
      assert.equal(received + snapshot.droppedTotal, settings.events);
      assert.equal(snapshot.lastDrop.reason, "queue_overflow");
    }
    dispatcher.close();
    return { durationMs, operations: settings.events, evidence: { published: settings.events, received, dropped: snapshot.droppedTotal, queueCapacity } };
  }, { eventsPerSample: settings.events, listenerMode: name });
}

function gitIdentity() {
  try {
    const head = readFileSync(join(ROOT, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    return readFileSync(join(ROOT, ".git", ref), "utf8").trim();
  } catch {
    return "unavailable";
  }
}

function environment() {
  const cpu = cpus()[0];
  const fs = statfsSync(workspace, { bigint: true });
  const npmAgent = process.env.npm_config_user_agent ?? "unavailable";
  return {
    label: `${platform()}-${release()}-${process.arch}-node${process.versions.node}`,
    node: process.version,
    npm: npmAgent.match(/npm\/([^\s]+)/)?.[1] ?? "unavailable",
    os: { platform: platform(), release: release(), architecture: process.arch },
    cpu: { model: cpu?.model ?? "unavailable", logicalCores: cpus().length },
    memoryBytes: { total: String(totalmem()), freeAtReport: String(freemem()) },
    filesystem: { placement: "OS temporary directory on the current host", type: "not portably detectable by Node.js", blockSizeBytes: String(fs.bsize), totalBytes: String(fs.blocks * fs.bsize), availableBytesAtReport: String(fs.bavail * fs.bsize) },
  };
}

// A failed run must not leave an older report looking like evidence from the current invocation.
rmSync(outputPath, { force: true });
if (summaryOutputPath) rmSync(summaryOutputPath, { force: true });

try {
  await ingressCase("capacity-disabled", createDefaultMonitorConfig().reservoir.capacity);
  await ingressCase("capacity-enabled-below-limits", { ...createDefaultMonitorConfig().reservoir.capacity, maxPendingRows: settings.events + 1, maxPendingSerializedBytes: 1_000_000_000n });
  await saturatedRefusal();
  await replayCase();
  await pruneCase("expired-pending", false);
  await pruneCase("terminal-delivered", true);
  await startupCases();
  await inspectionCase();
  await schedulerCase();
  for (const name of ["no-listener", "fast-listener", "slow-listener", "controlled-overflow"]) await lifecycleCase(name);

  const report = {
    schema: "causal-order-monitor/performance-baseline",
    version: 1,
    validity: "valid",
    generatedAt: new Date().toISOString(),
    scope: "Repository-local comparative baseline; results are not universal throughput claims.",
    environment: environment(),
    artifact: { kind: "working-tree TypeScript build", entrypoint: ".build/src/index.js", package: packageJson.name, packageVersion: packageJson.version, gitCommit: gitIdentity(), workingTree: "may include uncommitted release-candidate changes" },
    dependencies: {
      nodeSqlite: process.versions.sqlite,
      installed: Object.fromEntries(
        ["typescript", "@types/node", ...Object.keys(packageJson.peerDependencies)].map((name) => [name, packageLock.packages?.[`node_modules/${name}`]?.version ?? "unavailable"]),
      ),
      declaredPeers: packageJson.peerDependencies,
    },
    configuration: {
      profile,
      ...settings,
      concurrency: 1,
      databasePlacement: "OS temporary directory; one fresh SQLite database per sample",
      cleanup: "all sample databases removed after the complete run",
      payloadDistribution: `fixed JSON object with ${settings.payloadBytes}-character ASCII body plus event metadata`,
      timingBoundary: "scenario-specific operation only; setup and post-operation correctness assertions are excluded where separable; compare only identical harness versions and profiles",
    },
    comparisonPolicy: { sameEnvironmentRequired: true, repeatedRunsRequired: 3, reviewMedianIncreasePercent: 25, reviewP95IncreasePercent: 35, automaticTimingFailure: false },
    correctness: { status: "passed", rule: "The report is written only after every workload assertion passes; timing thresholds do not replace correctness." },
    cases,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
  console.log(`Benchmark report written to ${relative(ROOT, outputPath)} (${cases.length} cases).`);
  if (summaryOutputPath) {
    const summary = {
      ...report,
      cases: report.cases.map(({ samples: _samples, ...benchmarkCase }) => benchmarkCase),
      rawReport: relative(ROOT, outputPath),
    };
    mkdirSync(dirname(summaryOutputPath), { recursive: true });
    writeFileSync(summaryOutputPath, `${JSON.stringify(summary, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
    console.log(`Review summary written to ${relative(ROOT, summaryOutputPath)}.`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

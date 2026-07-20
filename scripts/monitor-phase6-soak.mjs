import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import {
  MONITOR_LIFECYCLE_EVENT_NAMES,
  MonitorAdmissionRefusedError,
  MonitorCapacityRefusedError,
  MonitorScheduler,
  TransportMonitorAdapter,
  monitorPackageVersion,
} from "../.build/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const NODE_IDS = ["edge-a", "edge-b", "edge-c", "edge-d", "edge-e", "edge-f", "edge-g", "edge-h"];
const PHASES = [
  { end: 0.08, name: "healthy", offline: [] },
  { end: 0.24, name: "extended_order_outage", offline: ["causal-order"] },
  { end: 0.34, name: "reconnect_burst", offline: [] },
  { end: 0.50, name: "full_downstream_outage", offline: ["dedupe", "causal-order"] },
  { end: 0.62, name: "retry_recovery", offline: [] },
  { end: 0.74, name: "repeated_order_outage", offline: ["causal-order"] },
  { end: 0.84, name: "observer_pressure_restart", offline: [] },
  { end: 1.00, name: "final_recovery", offline: [] },
];
const PROFILE_DEFAULTS = {
  smoke: { duration: "20m", timeScale: 120, eventsPerSecond: 2, capacityRows: 96, lifecycleQueue: 16 },
  medium: { duration: "2h", timeScale: 240, eventsPerSecond: 1, capacityRows: 192, lifecycleQueue: 32 },
  long: { duration: "8h", timeScale: 360, eventsPerSecond: 0.5, capacityRows: 256, lifecycleQueue: 32 },
  sustained: { duration: "10m", timeScale: 1, eventsPerSecond: 2, capacityRows: 96, lifecycleQueue: 16 },
  wallclock: { duration: "8h", timeScale: 1, eventsPerSecond: 15, capacityRows: 25_000, lifecycleQueue: 256 },
};

function findOption(args, name, fallback = null) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === name) return args[index + 1] ?? fallback;
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
  }
  return fallback;
}

function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(value);
  assert.ok(match, `Invalid duration '${value}'. Use ms, s, m, or h.`);
  return Math.round(Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()]);
}

function positiveNumber(value, name) {
  const number = Number(value);
  assert.ok(Number.isFinite(number) && number > 0, `${name} must be positive`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  assert.ok(Number.isFinite(number) && number >= 0, `${name} must be non-negative`);
  return number;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function json(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function currentPhase(progress) {
  return PHASES.find((phase) => progress < phase.end) ?? PHASES.at(-1);
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function installedVersions() {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
  const names = ["typescript", "@types/node", ...Object.keys(packageJson.peerDependencies)];
  return {
    declaredPeers: packageJson.peerDependencies,
    installed: Object.fromEntries(names.map((name) => [name, packageLock.packages?.[`node_modules/${name}`]?.version ?? "unavailable"])),
  };
}

function gitIdentity() {
  try {
    const head = readFileSync(resolve(ROOT, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    return readFileSync(resolve(ROOT, ".git", head.slice(5)), "utf8").trim();
  } catch {
    return "unavailable";
  }
}

const args = process.argv.slice(2);
const profile = findOption(args, "--profile", "smoke");
assert.ok(Object.hasOwn(PROFILE_DEFAULTS, profile), `Unknown profile '${profile}'`);
const defaults = PROFILE_DEFAULTS[profile];
const durationText = findOption(args, "--duration", defaults.duration);
const durationMs = parseDuration(durationText);
const timeScale = positiveNumber(findOption(args, "--time-scale", String(defaults.timeScale)), "--time-scale");
const eventsPerSecond = positiveNumber(findOption(args, "--events-per-second", String(defaults.eventsPerSecond)), "--events-per-second");
const capacityRows = Math.floor(positiveNumber(findOption(args, "--capacity-rows", String(defaults.capacityRows)), "--capacity-rows"));
const lifecycleQueue = Math.floor(positiveNumber(findOption(args, "--lifecycle-queue", String(defaults.lifecycleQueue)), "--lifecycle-queue"));
const replayBatchSize = Math.floor(positiveNumber(findOption(args, "--replay-batch-size", "16"), "--replay-batch-size"));
const schedulerIntervalMs = Math.floor(positiveNumber(findOption(args, "--scheduler-interval-ms", "25"), "--scheduler-interval-ms"));
const retryBackoffMs = BigInt(Math.floor(positiveNumber(findOption(args, "--retry-backoff-ms", "1000"), "--retry-backoff-ms")));
const duplicateRate = nonNegativeNumber(findOption(args, "--duplicate-rate", "0.01"), "--duplicate-rate");
assert.ok(duplicateRate <= 1, "--duplicate-rate must not exceed 1");
const seed = Math.floor(nonNegativeNumber(findOption(args, "--seed", "500009"), "--seed"));
const sampleIntervalWallMs = Math.floor(positiveNumber(findOption(args, "--sample-interval-ms", "250"), "--sample-interval-ms"));
const drainTimeoutMs = parseDuration(findOption(args, "--drain-timeout", "3m"));
const maxRssMb = positiveNumber(findOption(args, "--max-rss-mb", "512"), "--max-rss-mb");
const maxWalMb = positiveNumber(findOption(args, "--max-wal-mb", "64"), "--max-wal-mb");
const maxStableHeapGrowthMb = positiveNumber(findOption(args, "--max-stable-heap-growth-mb", "64"), "--max-stable-heap-growth-mb");
const outputPath = resolve(ROOT, findOption(args, "--output", `artifacts/validation/monitor-phase6-${profile}.json`));
const summaryOutput = findOption(args, "--summary-output");
const summaryPath = summaryOutput ? resolve(ROOT, summaryOutput) : null;
const databasePath = resolve(ROOT, findOption(args, "--database", `artifacts/soak/monitor-phase6-${profile}.sqlite`));

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(databasePath), { recursive: true });
rmSync(outputPath, { force: true });
if (summaryPath) rmSync(summaryPath, { force: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });

const startWallMs = Date.now();
const startEpochMs = BigInt(startWallMs);
const random = createRandom(seed);
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
const state = { transport: "online", dedupe: "online", "causal-order": "online" };
const nodeSequences = new Map(NODE_IDS.map((nodeId) => [nodeId, 0n]));
const recentEvents = [];
const upstreamQueue = [];
const dedupeSeen = new Set();
const orderSeen = new Set();
const lastOrderedSequence = new Map();
const samples = [];
const transitions = [];
const schedulerTickWallTimes = [];
const schedulerErrors = [];
const lifecycleObserved = Object.fromEntries(MONITOR_LIFECYCLE_EVENT_NAMES.map((name) => [name, 0]));
const phaseEvidence = Object.fromEntries(PHASES.map((phase) => [phase.name, { entered: false, generated: 0, accepted: 0, refusalAttempts: 0, maximumPendingRows: 0, maximumUpstreamQueue: 0 }]));
const counters = {
  generatedEmissions: 0,
  generatedUniqueEvents: 0,
  generatedDuplicateEmissions: 0,
  acceptedByMonitor: 0,
  capacityRefusalAttempts: 0,
  admissionRefusalAttempts: 0,
  upstreamQueued: 0,
  upstreamRetryAttempts: 0,
  replayDeliveriesThroughDedupe: 0,
  replayInjectedFailures: 0,
  retryWaitObserved: 0,
  orderDeliveries: 0,
  orderUniqueEvents: 0,
  orderDuplicateDeliveries: 0,
  orderSequenceRegressions: 0,
  dedupeDroppedDuplicates: 0,
  checkpoints: 0,
  restarts: 0,
  shutdowns: 0,
};
const maxima = {
  pendingRows: 0,
  pendingSerializedBytes: 0,
  upstreamQueue: 0,
  rssBytes: 0,
  heapUsedBytes: 0,
  databaseBytes: 0,
  walBytes: 0,
  activeHandles: 0,
  lifecycleQueueDepth: 0,
  lifecycleDroppedTotal: 0,
  lifecycleListenerFailureTotal: 0,
};
const ownerHistory = [];
let adapter;
let scheduler;
let activePhase = null;
let replayFailureInjected = false;
let injectedFailedEventId = null;
let retryDeadlineMs = null;
let firstReplaySuccessAfterFailureMs = null;
const replaySuccessAfterFailureTimes = [];
let restartCompleted = false;
let nextSampleWallMs = startWallMs;
let nextCheckpointAt = Math.max(60_000, Math.floor(durationMs / 6));
let fatalError = null;
let interrupted = false;
let drainStartWallMs = null;

function simulationElapsedMs() {
  if (drainStartWallMs !== null) {
    return durationMs + Math.floor((Date.now() - drainStartWallMs) * timeScale);
  }
  return Math.min(durationMs, Math.floor((Date.now() - startWallMs) * timeScale));
}

function simulationNow() {
  return startEpochMs + BigInt(simulationElapsedMs());
}

function createEmission() {
  if (recentEvents.length > 0 && random() < duplicateRate) {
    counters.generatedDuplicateEmissions += 1;
    return { ...recentEvents[Math.floor(random() * recentEvents.length)] };
  }
  const nodeId = NODE_IDS[Math.floor(random() * NODE_IDS.length)];
  const sequence = (nodeSequences.get(nodeId) ?? 0n) + 1n;
  nodeSequences.set(nodeId, sequence);
  const event = {
    id: `${nodeId}-${sequence}`,
    nodeId,
    sequence,
    clock: { physicalTimeMs: simulationNow(), logicalCounter: 0n, nodeId },
    ingestedAt: simulationNow(),
    payload: { kind: "phase6-soak", nodeId, sequence: sequence.toString(), body: "x".repeat(128) },
  };
  counters.generatedUniqueEvents += 1;
  recentEvents.push(event);
  if (recentEvents.length > 2_000) recentEvents.shift();
  return event;
}

function deliverToOrder(event) {
  assert.equal(state["causal-order"], "online", "order delivery attempted while offline");
  counters.orderDeliveries += 1;
  if (orderSeen.has(event.id)) {
    counters.orderDuplicateDeliveries += 1;
    return;
  }
  orderSeen.add(event.id);
  counters.orderUniqueEvents += 1;
  const previous = lastOrderedSequence.get(event.nodeId);
  if (previous !== undefined && event.sequence < previous) counters.orderSequenceRegressions += 1;
  if (previous === undefined || event.sequence > previous) lastOrderedSequence.set(event.nodeId, event.sequence);
}

function createAdapter() {
  const created = new TransportMonitorAdapter(
    {
      async deliverToDedupe(event, context) {
        assert.equal(state.dedupe, "online", "dedupe delivery attempted while offline");
        if (context.replay) {
          if (!replayFailureInjected && activePhase?.name === "retry_recovery") {
            replayFailureInjected = true;
            injectedFailedEventId = event.id;
            retryDeadlineMs = null;
            firstReplaySuccessAfterFailureMs = null;
            replaySuccessAfterFailureTimes.length = 0;
            counters.replayInjectedFailures += 1;
            throw new Error("injected Phase 6 replay failure");
          }
          counters.replayDeliveriesThroughDedupe += 1;
          if (retryDeadlineMs !== null && event.id === injectedFailedEventId && firstReplaySuccessAfterFailureMs === null) {
            firstReplaySuccessAfterFailureMs = simulationNow();
          }
          if (retryDeadlineMs !== null && event.id === injectedFailedEventId && replaySuccessAfterFailureTimes.length < 16) {
            replaySuccessAfterFailureTimes.push(simulationNow());
          }
        }
        if (dedupeSeen.has(event.id)) {
          counters.dedupeDroppedDuplicates += 1;
          return;
        }
        dedupeSeen.add(event.id);
        deliverToOrder(event);
      },
      deliverToOrder(event) {
        deliverToOrder(event);
      },
    },
    {
      now: simulationNow,
      reservoir: {
        databasePath,
        walAutoCheckpointPages: 1_000,
        pruneBatchSize: 64,
        capacity: {
          maxSerializedEventBytes: 16_384n,
          maxPendingRows: capacityRows,
          maxPendingSerializedBytes: BigInt(capacityRows * 4_096),
          filesystemReserve: null,
          overflowPolicy: "reject_new",
        },
      },
      lifecycle: {
        queueCapacity: lifecycleQueue,
        overflowPolicy: "drop_oldest",
        shutdownFlushTimeoutMs: 100n,
      },
      replay: {
        retryBackoffMs,
        healthConfirmationHeartbeats: 2,
        pauseLiveFlowDuringReplay: true,
      },
    },
  );

  for (const eventName of MONITOR_LIFECYCLE_EVENT_NAMES) {
    created.lifecycle.subscribe(eventName, () => { lifecycleObserved[eventName] += 1; });
  }
  created.lifecycle.subscribe("operationDurationObserved", async () => { await delay(4); });
  created.lifecycle.subscribe("storagePressureObserved", async () => { await delay(4); });
  created.lifecycle.subscribe("ingressAccepted", () => { throw new Error("intentional sync observer failure"); });
  created.lifecycle.subscribe("deliveryAttempted", async () => { throw new Error("intentional async observer rejection"); });

  for (const component of ["transport", "dedupe", "causal-order"]) {
    created.updateComponentHealth(component, { state: state[component], observedAt: simulationNow(), details: { owner: ownerHistory.length + 1 } });
  }
  return created;
}

function startScheduler() {
  const created = new MonitorScheduler({
    adapter,
    healthIntervalMs: schedulerIntervalMs,
    replayIntervalMs: schedulerIntervalMs,
    pruneIntervalMs: schedulerIntervalMs * 4,
    replayBatchSize,
    now: simulationNow,
    onError(error) {
      schedulerErrors.push({
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        simulatedAtMs: simulationElapsedMs(),
      });
    },
    healthProbe() {
      schedulerTickWallTimes.push(Date.now());
      for (const component of ["transport", "dedupe", "causal-order"]) {
        if (state[component] === "online") adapter.observeHeartbeat(component, simulationNow(), { phase: activePhase?.name ?? "startup" });
      }
    },
  });
  created.start();
  return created;
}

async function createOwner(reason) {
  const started = performance.now();
  adapter = createAdapter();
  const startupDurationMs = performance.now() - started;
  scheduler = startScheduler();
  ownerHistory.push({ reason, startupDurationMs, pendingRowsAtStart: adapter.getRuntime().getReservoirStats().totalPendingRows });
}

async function setPhase(phase) {
  if (activePhase?.name === phase.name) return;
  activePhase = phase;
  phaseEvidence[phase.name].entered = true;
  const offline = new Set(phase.offline);
  for (const component of ["transport", "dedupe", "causal-order"]) {
    const desired = offline.has(component) ? "offline" : "online";
    if (state[component] === desired) continue;
    state[component] = desired;
    adapter.updateComponentHealth(component, { state: desired, observedAt: simulationNow(), reasonCode: desired === "offline" ? "PHASE6_INJECTED" : null, details: { phase: phase.name } });
  }
  transitions.push({ phase: phase.name, offline: phase.offline, simulatedAtMs: simulationElapsedMs(), wallAt: new Date().toISOString() });
  console.log(`phase=${phase.name} simulated=${Math.floor(simulationElapsedMs() / 1000)}s offline=${phase.offline.join(",") || "none"}`);
}

async function attemptIngress(event, phaseRecord, retry = false) {
  try {
    await adapter.ingest(event, event.nodeId);
    counters.acceptedByMonitor += 1;
    phaseRecord.accepted += 1;
    return true;
  } catch (error) {
    if (error instanceof MonitorCapacityRefusedError || error instanceof MonitorAdmissionRefusedError) {
      if (error instanceof MonitorCapacityRefusedError) counters.capacityRefusalAttempts += 1;
      else counters.admissionRefusalAttempts += 1;
      phaseRecord.refusalAttempts += 1;
      if (!retry) counters.upstreamQueued += 1;
      return false;
    }
    throw error;
  }
}

async function emitNew(phaseRecord) {
  const event = createEmission();
  counters.generatedEmissions += 1;
  phaseRecord.generated += 1;
  if (!(await attemptIngress(event, phaseRecord))) upstreamQueue.push(event);
}

async function retryUpstream(phaseRecord) {
  const capacity = adapter.capacity.getSnapshot();
  if (capacity.usage.pendingRows >= capacityRows || capacity.admission.posture === "refusing") return;
  const attempts = Math.min(replayBatchSize, upstreamQueue.length);
  for (let index = 0; index < attempts; index += 1) {
    const event = upstreamQueue.shift();
    counters.upstreamRetryAttempts += 1;
    if (!(await attemptIngress(event, phaseRecord, true))) upstreamQueue.push(event);
  }
}

async function restartUnderPressure() {
  if (restartCompleted || !replayFailureInjected) return;
  if (adapter.getReplaySnapshot().nextRetryAt === null) return;
  await scheduler.stop();
  const schedulerState = scheduler.getState();
  const pendingBefore = adapter.getRuntime().getReservoirStats().totalPendingRows;
  const retryBefore = adapter.getReplaySnapshot().nextRetryAt;
  assert.notEqual(retryBefore, null, "retry deadline must survive scheduler cancellation");
  retryDeadlineMs = retryBefore;
  for (let index = 0; index < lifecycleQueue * 4; index += 1) adapter.getOperatorSnapshot();
  await Promise.resolve();
  const lifecycleBefore = adapter.lifecycle.getSnapshot();
  const flushResult = await adapter.lifecycle.flush(1n);
  const shutdownStarted = performance.now();
  adapter.close();
  const shutdownDurationMs = performance.now() - shutdownStarted;
  counters.shutdowns += 1;
  await createOwner("restart_during_retry_and_observer_pressure");
  counters.restarts += 1;
  const pendingAfter = adapter.getRuntime().getReservoirStats().totalPendingRows;
  assert.equal(pendingAfter, pendingBefore, "restart must preserve every pending row");
  ownerHistory.at(-2).shutdown = { shutdownDurationMs, pendingRows: pendingBefore, retryAtMs: retryBefore, schedulerState, lifecycleBefore, flushResult };
  ownerHistory.at(-1).pendingRowsAfterRestart = pendingAfter;
  restartCompleted = true;
}

function activeHandleCount() {
  return typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null;
}

function captureSample(force = false) {
  if (!force && Date.now() < nextSampleWallMs) return;
  nextSampleWallMs = Date.now() + sampleIntervalWallMs;
  const operator = adapter.getOperatorSnapshot();
  const capacity = adapter.capacity.getSnapshot();
  const lifecycle = adapter.lifecycle.getSnapshot();
  const memory = process.memoryUsage();
  const handles = activeHandleCount();
  const sample = {
    wallAt: new Date().toISOString(),
    wallElapsedMs: Date.now() - startWallMs,
    simulatedElapsedMs: simulationElapsedMs(),
    phase: activePhase?.name ?? "startup",
    pendingRows: operator.backlog.totalRows,
    pendingSerializedBytes: Number(capacity.usage.pendingSerializedBytes),
    upstreamQueue: upstreamQueue.length,
    replayState: operator.replay.state,
    retryWaitingRows: operator.backlog.retryWaitingRows,
    retryAtMs: operator.replay.nextRetryAtMs,
    capacityAdmission: capacity.admission,
    capacityRefusedTotal: capacity.counters.refusedTotal,
    databaseBytes: Number(capacity.usage.databaseBytes ?? 0),
    walBytes: Number(capacity.usage.walBytes ?? 0),
    filesystemAvailableBytes: capacity.usage.filesystemAvailableBytes,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    activeHandles: handles,
    lifecycle,
    scheduler: scheduler.getState(),
  };
  samples.push(sample);
  maxima.pendingRows = Math.max(maxima.pendingRows, sample.pendingRows);
  maxima.pendingSerializedBytes = Math.max(maxima.pendingSerializedBytes, sample.pendingSerializedBytes);
  maxima.upstreamQueue = Math.max(maxima.upstreamQueue, sample.upstreamQueue);
  maxima.rssBytes = Math.max(maxima.rssBytes, sample.rssBytes);
  maxima.heapUsedBytes = Math.max(maxima.heapUsedBytes, sample.heapUsedBytes);
  maxima.databaseBytes = Math.max(maxima.databaseBytes, sample.databaseBytes);
  maxima.walBytes = Math.max(maxima.walBytes, sample.walBytes);
  maxima.activeHandles = Math.max(maxima.activeHandles, handles ?? 0);
  maxima.lifecycleQueueDepth = Math.max(maxima.lifecycleQueueDepth, lifecycle.queueDepth);
  maxima.lifecycleDroppedTotal = Math.max(maxima.lifecycleDroppedTotal, lifecycle.droppedTotal);
  maxima.lifecycleListenerFailureTotal = Math.max(maxima.lifecycleListenerFailureTotal, lifecycle.listenerFailureTotal);
  const phaseRecord = phaseEvidence[sample.phase];
  phaseRecord.maximumPendingRows = Math.max(phaseRecord.maximumPendingRows, sample.pendingRows);
  phaseRecord.maximumUpstreamQueue = Math.max(phaseRecord.maximumUpstreamQueue, sample.upstreamQueue);
}

function databaseEvidence() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const counts = {};
    for (const table of ["ingress_events", "component_health_log", "replay_sessions"]) {
      const statement = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
      statement.setReadBigInts(true);
      counts[table] = Number(statement.get().count);
    }
    const integrity = db.prepare("PRAGMA quick_check").get();
    return { counts, integrity: Object.values(integrity)[0] };
  } finally {
    db.close();
  }
}

function buildEnvironment() {
  const filesystem = statfsSync(dirname(databasePath), { bigint: true });
  return {
    label: `${platform()}-${release()}-${process.arch}-node${process.versions.node}`,
    node: process.version,
    npm: process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/)?.[1] ?? "unavailable",
    nodeSqlite: process.versions.sqlite,
    os: { platform: platform(), release: release(), architecture: process.arch },
    cpu: { model: cpus()[0]?.model ?? "unavailable", logicalCores: cpus().length },
    memoryBytes: { total: String(totalmem()), freeAtReport: String(freemem()) },
    filesystem: { blockSizeBytes: String(filesystem.bsize), totalBytes: String(filesystem.blocks * filesystem.bsize), availableBytesAtReport: String(filesystem.bavail * filesystem.bsize) },
    dependencies: installedVersions(),
  };
}

function resourceAnalysis() {
  const stable = samples.filter((sample) => sample.simulatedElapsedMs >= durationMs * 0.25);
  const first = stable[0] ?? samples[0];
  const last = stable.at(-1) ?? samples.at(-1);
  const heapGrowthBytes = last.heapUsedBytes - first.heapUsedBytes;
  const rssGrowthBytes = last.rssBytes - first.rssBytes;
  const handleGrowth = last.activeHandles === null || first.activeHandles === null ? null : last.activeHandles - first.activeHandles;
  return {
    stableWindow: { fromSimulatedMs: first.simulatedElapsedMs, toSimulatedMs: last.simulatedElapsedMs, sampleCount: stable.length },
    heapGrowthBytes,
    rssGrowthBytes,
    activeHandleGrowth: handleGrowth,
    databaseGrowthExplanation: "Expected retained delivered rows and bounded health/replay history; terminal retention has not elapsed during this run.",
    conclusions: {
      heapWithinEnvelope: heapGrowthBytes <= maxStableHeapGrowthMb * 1_048_576,
      rssWithinEnvelope: maxima.rssBytes <= maxRssMb * 1_048_576,
      activeHandlesWithinEnvelope: handleGrowth === null || handleGrowth <= 8,
      walWithinEnvelope: maxima.walBytes <= maxWalMb * 1_048_576,
      logicalCapacityWithinEnvelope: maxima.pendingRows <= capacityRows,
    },
  };
}

function eventLoopEvidence() {
  const toMs = (nanoseconds) => Number((nanoseconds / 1_000_000).toFixed(3));
  return { minimumMs: toMs(eventLoop.min), meanMs: toMs(eventLoop.mean), p95Ms: toMs(eventLoop.percentile(95)), p99Ms: toMs(eventLoop.percentile(99)), maximumMs: toMs(eventLoop.max) };
}

function schedulerEvidence() {
  const gaps = schedulerTickWallTimes.slice(1).map((value, index) => value - schedulerTickWallTimes[index]);
  const maximumGapMs = gaps.reduce((maximum, gap) => Math.max(maximum, gap), 0);
  return {
    configuredIntervalMs: schedulerIntervalMs,
    healthProbeCount: schedulerTickWallTimes.length,
    errors: schedulerErrors,
    wallGapMs: gaps.length === 0 ? null : { median: percentile(gaps, 0.5), p95: percentile(gaps, 0.95), maximum: maximumGapMs },
    oneInFlightReplayAuthority: "MonitorScheduler tick coalescing plus the retained Chunk 8 deterministic contract",
  };
}

async function main() {
  await createOwner("fresh_start");
  let emittedTarget = 0;
  while (!interrupted && simulationElapsedMs() < durationMs) {
    const elapsed = simulationElapsedMs();
    const phase = currentPhase(elapsed / durationMs);
    await setPhase(phase);
    const record = phaseEvidence[phase.name];
    if (state.dedupe === "online" && state["causal-order"] === "online") await retryUpstream(record);
    const target = Math.floor((elapsed / 1_000) * eventsPerSecond);
    const count = Math.min(64, Math.max(0, target - emittedTarget));
    for (let index = 0; index < count; index += 1) {
      await emitNew(record);
      emittedTarget += 1;
    }
    if (state.dedupe === "online" && state["causal-order"] === "online") await retryUpstream(record);
    const replay = adapter.getReplaySnapshot();
    if (replay.state === "failed" && replay.nextRetryAt !== null) {
      counters.retryWaitObserved += 1;
      if (replayFailureInjected) retryDeadlineMs = replay.nextRetryAt;
    }
    if (phase.name === "retry_recovery" || phase.name === "observer_pressure_restart") await restartUnderPressure();
    if (elapsed >= nextCheckpointAt) {
      adapter.getRuntime().checkpointReservoirWal("passive");
      counters.checkpoints += 1;
      nextCheckpointAt += Math.max(60_000, Math.floor(durationMs / 6));
    }
    captureSample();
    await delay(10);
  }

  await setPhase(PHASES.at(-1));
  const drainStarted = Date.now();
  drainStartWallMs = drainStarted;
  while (!interrupted) {
    await retryUpstream(phaseEvidence.final_recovery);
    const snapshot = adapter.getOperatorSnapshot();
    captureSample();
    if (upstreamQueue.length === 0 && snapshot.backlog.totalRows === 0 && snapshot.replay.state === "idle") break;
    assert.ok(Date.now() - drainStarted <= drainTimeoutMs, "final drain exceeded --drain-timeout");
    await delay(10);
  }
  assert.equal(interrupted, false, "qualification was interrupted");
  captureSample(true);

  assert.equal(replayFailureInjected, true, "replay failure scenario was not exercised");
  assert.equal(restartCompleted, true, "restart scenario was not exercised");
  assert.ok(counters.capacityRefusalAttempts > 0, "capacity refusal was not exercised");
  assert.ok(counters.retryWaitObserved > 0, "persisted retry wait was not observed");
  assert.ok(counters.replayDeliveriesThroughDedupe > 0, "replay did not traverse dedupe");
  assert.equal(upstreamQueue.length, 0, "upstream-owned refused work did not drain");
  assert.equal(adapter.getRuntime().getReservoirStats().totalPendingRows, 0, "accepted pending work did not drain");
  assert.equal(counters.acceptedByMonitor, counters.generatedEmissions, "every generated emission must eventually be accepted exactly once");
  assert.equal(orderSeen.size, counters.generatedUniqueEvents, "every generated unique event must reach order");
  assert.equal(counters.orderSequenceRegressions, 0, "per-node order regressed");
  assert.ok(firstReplaySuccessAfterFailureMs !== null && firstReplaySuccessAfterFailureMs >= retryDeadlineMs, "failed replay row resumed before its persisted retry deadline");
  assert.ok(maxima.pendingRows <= capacityRows, "logical pending rows exceeded configured capacity");
  assert.ok(maxima.lifecycleDroppedTotal > 0, "controlled lifecycle overflow was not observed");
  assert.ok(maxima.lifecycleListenerFailureTotal > 0, "listener failure isolation was not observed");
  for (const phase of PHASES) assert.equal(phaseEvidence[phase.name].entered, true, `phase '${phase.name}' was not entered`);

  const analysis = resourceAnalysis();
  for (const [name, passed] of Object.entries(analysis.conclusions)) assert.equal(passed, true, `resource envelope failed: ${name}`);

  await scheduler.stop();
  const finalLifecycle = adapter.lifecycle.getSnapshot();
  const finalCapacity = adapter.capacity.getSnapshot();
  const finalOperator = adapter.getOperatorSnapshot();
  const shutdownStarted = performance.now();
  adapter.close();
  const finalShutdownDurationMs = performance.now() - shutdownStarted;
  counters.shutdowns += 1;
  const database = databaseEvidence();
  assert.equal(database.integrity, "ok", "SQLite quick_check failed after shutdown");

  const reopenStarted = performance.now();
  const reopened = createAdapter();
  const reopenDurationMs = performance.now() - reopenStarted;
  assert.equal(reopened.getRuntime().getReservoirStats().totalPendingRows, 0, "final reservoir did not reopen drained");
  reopened.close();

  eventLoop.disable();
  const report = {
    schema: "causal-order-monitor/phase6-soak-validation",
    version: 1,
    status: "passed",
    generatedAt: new Date().toISOString(),
    scope: timeScale === 1 ? "continuous wall-clock qualification" : "accelerated long-horizon qualification; not a claim of continuous wall-clock duration",
    artifact: { kind: "working-tree TypeScript build", package: "@causal-order/monitor", packageVersion: monitorPackageVersion, gitCommit: gitIdentity(), workingTree: "cumulative uncommitted v0.5.0 release-candidate changes" },
    environment: buildEnvironment(),
    configuration: { profile, duration: durationText, simulatedDurationMs: durationMs, timeScale, eventsPerSecond, duplicateRate, seed, nodeIds: NODE_IDS, databasePlacement: databasePath, capacityRows, maxPendingSerializedBytes: String(capacityRows * 4_096), lifecycleQueue, replayBatchSize, retryBackoffMs: String(retryBackoffMs), schedulerIntervalMs, sampleIntervalWallMs, limits: { maxRssMb, maxWalMb, maxStableHeapGrowthMb } },
    timing: { startedAt: new Date(startWallMs).toISOString(), wallElapsedMs: Date.now() - startWallMs, simulatedElapsedMs: simulationElapsedMs(), drainWallMs: Date.now() - drainStarted, finalShutdownDurationMs, finalReopenDurationMs: reopenDurationMs },
    counters,
    maxima,
    phaseEvidence,
    transitions,
    ownerHistory,
    lifecycle: { observedByType: lifecycleObserved, final: finalLifecycle },
    scheduler: schedulerEvidence(),
    retry: { failedEventId: injectedFailedEventId, persistedDeadlineMs: retryDeadlineMs, firstSuccessfulReplayAtMs: firstReplaySuccessAfterFailureMs, successfulReplaySampleTimesMs: replaySuccessAfterFailureTimes },
    eventLoop: eventLoopEvidence(),
    resourceAnalysis: analysis,
    final: { upstreamQueue: upstreamQueue.length, operator: finalOperator, capacity: finalCapacity, database },
    samples,
    fatalError: null,
  };
  writeFileSync(outputPath, `${json(report)}\n`, "utf8");
  if (summaryPath) {
    const { samples: _samples, transitions: _transitions, ...summary } = report;
    summary.rawReport = relative(ROOT, outputPath);
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, `${json(summary)}\n`, "utf8");
  }
  console.log(`Phase 6 ${profile} qualification passed: generated=${counters.generatedEmissions} refusalAttempts=${counters.capacityRefusalAttempts} replayed=${counters.replayDeliveriesThroughDedupe} wall=${report.timing.wallElapsedMs}ms`);
}

process.once("SIGINT", () => { interrupted = true; });
process.once("SIGTERM", () => { interrupted = true; });

try {
  await main();
} catch (error) {
  fatalError = error instanceof Error ? error : new Error(String(error));
  eventLoop.disable();
  const failed = { schema: "causal-order-monitor/phase6-soak-validation", version: 1, status: "failed", generatedAt: new Date().toISOString(), configuration: { profile, duration: durationText, timeScale, eventsPerSecond, seed }, counters, maxima, retry: { failedEventId: injectedFailedEventId, persistedDeadlineMs: retryDeadlineMs, firstSuccessfulReplayAtMs: firstReplaySuccessAfterFailureMs, successfulReplaySampleTimesMs: replaySuccessAfterFailureTimes }, schedulerErrors, fatalError: { name: fatalError.name, message: fatalError.message, stack: fatalError.stack } };
  writeFileSync(outputPath, `${json(failed)}\n`, "utf8");
  console.error(fatalError);
  process.exitCode = 1;
  try { await scheduler?.stop(); } catch {}
  try { adapter?.close(); } catch {}
}

import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  MonitorAdmissionRefusedError,
  TransportMonitorAdapter,
  monitorPackageVersion,
} from "../.build/src/index.js";

const DEFAULT_NODES = [
  "edge-a",
  "edge-b",
  "edge-c",
  "edge-d",
  "edge-e",
  "edge-f",
  "edge-g",
  "edge-h",
];

const FAULT_PHASES = [
  { end: 0.10, name: "healthy_start", offline: [] },
  { end: 0.16, name: "transport_only", offline: ["transport"] },
  { end: 0.20, name: "recovery_after_transport", offline: [] },
  { end: 0.26, name: "dedupe_only", offline: ["dedupe"] },
  { end: 0.30, name: "recovery_after_dedupe", offline: [] },
  { end: 0.36, name: "causal_order_only", offline: ["causal-order"] },
  { end: 0.40, name: "recovery_after_causal_order", offline: [] },
  { end: 0.46, name: "transport_and_dedupe", offline: ["transport", "dedupe"] },
  { end: 0.50, name: "recovery_after_transport_dedupe", offline: [] },
  { end: 0.56, name: "transport_and_causal_order", offline: ["transport", "causal-order"] },
  { end: 0.60, name: "recovery_after_transport_order", offline: [] },
  { end: 0.66, name: "dedupe_and_causal_order", offline: ["dedupe", "causal-order"] },
  { end: 0.70, name: "recovery_after_dual_downstream", offline: [] },
  { end: 0.78, name: "triple_outage", offline: ["transport", "dedupe", "causal-order"] },
  { end: 1.00, name: "final_recovery_and_drain", offline: [] },
];

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
  if (!match) throw new Error(`Invalid duration '${value}'. Use ms, s, m, or h.`);
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Math.round(Number(match[1]) * multipliers[match[2].toLowerCase()]);
}

function parsePositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return number;
}

function json(value) {
  return JSON.stringify(
    value,
    (_, item) => typeof item === "bigint" ? item.toString() : item,
    2,
  );
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function currentPhase(progress) {
  return FAULT_PHASES.find((phase) => progress < phase.end) ?? FAULT_PHASES.at(-1);
}

const args = process.argv.slice(2);
const durationText = findOption(args, "--duration", "8h");
const durationMs = parseDuration(durationText);
const timeScale = parsePositiveNumber(findOption(args, "--time-scale", "1"), "--time-scale");
const eventsPerSecond = parsePositiveNumber(
  findOption(args, "--events-per-second", "15"),
  "--events-per-second",
);
const duplicateRate = Number(findOption(args, "--duplicate-rate", "0.01"));
const jitterMs = Number(findOption(args, "--jitter-ms", "250"));
const reportIntervalMs = parseDuration(findOption(args, "--report-interval", "15m"));
const drainTimeoutMs = parseDuration(findOption(args, "--drain-timeout", "30m"));
const replayBatchSize = Number(findOption(args, "--replay-batch-size", "200"));
const reconnectBatchSize = Number(findOption(args, "--reconnect-batch-size", "250"));
const maxRssMb = Number(findOption(args, "--max-rss-mb", "1024"));
const maxWalMb = Number(findOption(args, "--max-wal-mb", "512"));
const maxPendingRows = Number(findOption(args, "--max-pending-rows", "250000"));
const maxLoopGapMs = parseDuration(findOption(args, "--max-loop-gap", "30s"));
const seed = Number(findOption(args, "--seed", "310031"));
const nodeIds = findOption(args, "--node-ids", DEFAULT_NODES.join(","))
  .split(",")
  .map((nodeId) => nodeId.trim())
  .filter(Boolean);
const outputPath = resolve(
  findOption(
    args,
    "--output",
    `artifacts/validation/monitor-combined-wallclock-${durationText.replace(/[^a-z0-9]/gi, "-")}-8nodes.json`,
  ),
);
const databasePath = resolve(
  findOption(args, "--database", "artifacts/soak/monitor-combined-wallclock.sqlite"),
);

if (nodeIds.length !== 8) throw new Error("The combined wall-clock contract requires exactly 8 node IDs.");
if (!(duplicateRate >= 0 && duplicateRate <= 1)) throw new Error("--duplicate-rate must be between 0 and 1.");
if (!(jitterMs >= 0)) throw new Error("--jitter-ms cannot be negative.");

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(databasePath), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });

const random = createRandom(seed);
const startWallMs = Date.now();
const startEpochMs = BigInt(startWallMs);
const state = {
  transport: "online",
  dedupe: "online",
  "causal-order": "online",
};
const counters = {
  generatedEmissions: 0,
  generatedUniqueEvents: 0,
  generatedDuplicateEmissions: 0,
  acceptedByMonitor: 0,
  refusedBeforePersistence: 0,
  indeterminateFailures: 0,
  upstreamHeld: 0,
  upstreamReleased: 0,
  buffered: 0,
  forwardedToDedupe: 0,
  forwardedDirectlyToOrder: 0,
  replayDeliveriesThroughDedupe: 0,
  dedupeDroppedDuplicates: 0,
  orderDeliveries: 0,
  orderUniqueEvents: 0,
  orderDuplicateDeliveries: 0,
  orderSequenceRegressions: 0,
  replayFailures: 0,
  maximumPendingRows: 0,
  maximumUpstreamQueue: 0,
  maximumRssBytes: 0,
  maximumHeapUsedBytes: 0,
  maximumDatabaseBytes: 0,
  maximumWalBytes: 0,
};
const phaseEvidence = Object.fromEntries(
  FAULT_PHASES.map((phase) => [phase.name, {
    entered: false,
    samples: 0,
    generated: 0,
    accepted: 0,
    upstreamHeld: 0,
    routingModes: {},
    operatorStatuses: {},
  }]),
);
const transitions = [];
const samples = [];
const upstreamQueue = [];
const recentEvents = [];
const dedupeSeen = new Set();
const orderSeen = new Set();
const lastOrderedSequence = new Map();
const nodeSequences = new Map(nodeIds.map((nodeId) => [nodeId, 0n]));
let activePhase = null;
let stopped = false;
let fatalError = null;
let nextReportAt = reportIntervalMs;
let nextHeartbeatAt = 0;
let nextPruneAt = 60_000;
let lastLoopWallMs = Date.now();
let lastStoredSampleAt = -Infinity;
const sampleStorageIntervalMs = Math.max(
  1_000,
  Math.min(60_000, Math.floor(reportIntervalMs / 3)),
);

function simulationElapsedMs() {
  return Math.min(durationMs, Math.floor((Date.now() - startWallMs) * timeScale));
}

function simulationNow() {
  return startEpochMs + BigInt(simulationElapsedMs());
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function createEmission() {
  const duplicate = recentEvents.length > 0 && random() < duplicateRate;
  if (duplicate) {
    counters.generatedDuplicateEmissions += 1;
    return { ...recentEvents[Math.floor(random() * recentEvents.length)] };
  }

  const nodeId = nodeIds[Math.floor(random() * nodeIds.length)];
  const sequence = (nodeSequences.get(nodeId) ?? 0n) + 1n;
  nodeSequences.set(nodeId, sequence);
  const jitter = Math.round((random() * 2 - 1) * jitterMs);
  const physicalTimeMs = simulationNow() + BigInt(jitter);
  const event = {
    id: `${nodeId}-${sequence}`,
    nodeId,
    sequence,
    clock: { physicalTimeMs },
    ingestedAt: simulationNow(),
    payload: {
      kind: "combined-wallclock",
      sequence: sequence.toString(),
      jitterMs: jitter,
    },
  };
  counters.generatedUniqueEvents += 1;
  recentEvents.push(event);
  if (recentEvents.length > 10_000) recentEvents.shift();
  return event;
}

function deliverToOrder(event, context) {
  if (state["causal-order"] !== "online") {
    throw new Error("causal-order delivery attempted while offline");
  }
  counters.orderDeliveries += 1;
  if (orderSeen.has(event.id)) {
    counters.orderDuplicateDeliveries += 1;
  } else {
    orderSeen.add(event.id);
    counters.orderUniqueEvents += 1;
  }
  if (typeof event.sequence === "bigint") {
    const previous = lastOrderedSequence.get(event.nodeId);
    if (previous !== undefined && event.sequence < previous) {
      counters.orderSequenceRegressions += 1;
    }
    if (previous === undefined || event.sequence > previous) {
      lastOrderedSequence.set(event.nodeId, event.sequence);
    }
  }
  if (context.deliveryMode === "dedupe_bypass") {
    counters.forwardedDirectlyToOrder += 1;
  }
}

const adapter = new TransportMonitorAdapter(
  {
    deliverToDedupe(event, context) {
      if (state.dedupe !== "online") {
        throw new Error("dedupe delivery attempted while offline");
      }
      if (context.replay) {
        assert.equal(context.deliveryMode, "replay_through_dedupe");
        counters.replayDeliveriesThroughDedupe += 1;
      } else {
        counters.forwardedToDedupe += 1;
      }
      if (dedupeSeen.has(event.id)) {
        counters.dedupeDroppedDuplicates += 1;
        return;
      }
      dedupeSeen.add(event.id);
      deliverToOrder(event, context);
    },
    deliverToOrder,
    onBuffered() {
      counters.buffered += 1;
    },
    onReplayStateChange(snapshot) {
      if (snapshot.state === "failed") counters.replayFailures += 1;
    },
  },
  {
    now: simulationNow,
    reservoir: {
      databasePath,
      walAutoCheckpointPages: 1_000,
      pruneBatchSize: 1_000,
    },
    replay: {
      retryBackoffMs: 5_000n,
      healthConfirmationHeartbeats: 2,
      pauseLiveFlowDuringReplay: true,
    },
  },
);

async function setPhase(phase) {
  if (activePhase?.name === phase.name) return;
  activePhase = phase;
  phaseEvidence[phase.name].entered = true;
  const offline = new Set(phase.offline);
  for (const component of ["transport", "dedupe", "causal-order"]) {
    const desired = offline.has(component) ? "offline" : "online";
    if (state[component] === desired) continue;
    state[component] = desired;
    adapter.updateComponentHealth(component, {
      state: desired,
      observedAt: simulationNow(),
      reasonCode: desired === "offline" ? "COMBINED_WALLCLOCK_INJECTED" : null,
      details: { phase: phase.name },
    });
  }
  transitions.push({
    phase: phase.name,
    offline: phase.offline,
    simulatedAtMs: simulationElapsedMs(),
    wallAt: new Date().toISOString(),
  });
  console.log(
    `${new Date().toISOString()} phase=${phase.name} offline=${phase.offline.join(",") || "none"}`,
  );
}

async function acceptEmission(event, phaseRecord) {
  if (state.transport !== "online") {
    upstreamQueue.push(event);
    counters.upstreamHeld += 1;
    phaseRecord.upstreamHeld += 1;
    return;
  }
  try {
    const result = await adapter.ingest(event, event.nodeId);
    counters.acceptedByMonitor += 1;
    phaseRecord.accepted += 1;
    if (result.forwardedTo === "buffer") counters.buffered += 0;
  } catch (error) {
    if (error instanceof MonitorAdmissionRefusedError) {
      counters.refusedBeforePersistence += 1;
      upstreamQueue.push(event);
      return;
    }
    counters.indeterminateFailures += 1;
    throw error;
  }
}

async function releaseUpstream(phaseRecord) {
  if (state.transport !== "online") return;
  const count = Math.min(reconnectBatchSize, upstreamQueue.length);
  for (let index = 0; index < count; index += 1) {
    const event = upstreamQueue.shift();
    await acceptEmission(event, phaseRecord);
    counters.upstreamReleased += 1;
  }
}

async function heartbeatAndRecover(elapsedMs) {
  if (elapsedMs >= nextHeartbeatAt) {
    for (const component of ["transport", "dedupe", "causal-order"]) {
      if (state[component] === "online") {
        adapter.observeHeartbeat(component, simulationNow(), { phase: activePhase.name });
      }
    }
    nextHeartbeatAt = elapsedMs + 1_000;
  }
  if (state.dedupe === "online" && state["causal-order"] === "online") {
    for (let batch = 0; batch < 10; batch += 1) {
      const result = await adapter.reconcileRecovery(replayBatchSize);
      if (result === null || result.claimedCount === 0) break;
    }
  }
  if (elapsedMs >= nextPruneAt) {
    for (let batch = 0; batch < 20; batch += 1) {
      const result = adapter.getRuntime().pruneReservoir();
      if (result.markedDeadLetter === 0 && result.deletedRows === 0) break;
    }
    nextPruneAt = elapsedMs + 60_000;
  }
}

function captureSample(elapsedMs, phaseName) {
  const operator = adapter.getOperatorSnapshot();
  const memory = process.memoryUsage();
  const databaseBytes = Number(operator.storage.databaseBytes ?? 0);
  const walBytes = Number(operator.storage.walBytes ?? 0);
  counters.maximumPendingRows = Math.max(counters.maximumPendingRows, operator.backlog.totalRows);
  counters.maximumUpstreamQueue = Math.max(counters.maximumUpstreamQueue, upstreamQueue.length);
  counters.maximumRssBytes = Math.max(counters.maximumRssBytes, memory.rss);
  counters.maximumHeapUsedBytes = Math.max(counters.maximumHeapUsedBytes, memory.heapUsed);
  counters.maximumDatabaseBytes = Math.max(counters.maximumDatabaseBytes, databaseBytes);
  counters.maximumWalBytes = Math.max(counters.maximumWalBytes, walBytes);
  const phaseRecord = phaseEvidence[phaseName];
  phaseRecord.samples += 1;
  increment(phaseRecord.routingModes, operator.routingMode);
  increment(phaseRecord.operatorStatuses, operator.status);
  const sample = {
    simulatedElapsedMs: elapsedMs,
    wallAt: new Date().toISOString(),
    phase: phaseName,
    offline: activePhase.offline,
    upstreamQueue: upstreamQueue.length,
    pendingRows: operator.backlog.totalRows,
    retryWaitingRows: operator.backlog.retryWaitingRows,
    replayState: operator.replay.state,
    routingMode: operator.routingMode,
    status: operator.status,
    gateClosed: operator.replay.gateClosed,
    admission: operator.admission,
    storage: operator.storage,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
  if (elapsedMs - lastStoredSampleAt >= sampleStorageIntervalMs) {
    samples.push(sample);
    lastStoredSampleAt = elapsedMs;
  }
  return sample;
}

function buildReport(status, finalSnapshot = null) {
  return {
    schema: "causal-order-monitor/combined-wallclock-validation",
    version: 1,
    status,
    monitorVersion: monitorPackageVersion,
    generatedAt: new Date().toISOString(),
    configuration: {
      duration: durationText,
      durationMs,
      timeScale,
      eventsPerSecond,
      duplicateRate,
      jitterMs,
      nodeIds,
      seed,
      databasePath,
      outputPath,
      limits: { maxRssMb, maxWalMb, maxPendingRows },
      maxLoopGapMs,
    },
    timing: {
      startedAt: new Date(startWallMs).toISOString(),
      wallElapsedMs: Date.now() - startWallMs,
      simulatedElapsedMs: simulationElapsedMs(),
    },
    counters,
    phaseEvidence,
    transitions,
    samples,
    finalSnapshot,
    fatalError: fatalError === null
      ? null
      : { name: fatalError.name, message: fatalError.message, stack: fatalError.stack },
  };
}

function persistReport(status, finalSnapshot = null) {
  writeFileSync(outputPath, `${json(buildReport(status, finalSnapshot))}\n`, "utf8");
}

async function main() {
  for (const component of ["transport", "dedupe", "causal-order"]) {
    adapter.updateComponentHealth(component, {
      state: "online",
      observedAt: simulationNow(),
      details: { phase: "healthy_start" },
    });
  }

  let emittedTarget = 0;
  while (!stopped && simulationElapsedMs() < durationMs) {
    const loopWallMs = Date.now();
    const loopGapMs = loopWallMs - lastLoopWallMs;
    if (loopGapMs > maxLoopGapMs) {
      throw new Error(
        `Wall-clock loop gap ${loopGapMs} ms exceeded --max-loop-gap ${maxLoopGapMs} ms; ` +
        "the host may have slept or the process stalled.",
      );
    }
    lastLoopWallMs = loopWallMs;
    const elapsedMs = simulationElapsedMs();
    const phase = currentPhase(elapsedMs / durationMs);
    await setPhase(phase);
    const phaseRecord = phaseEvidence[phase.name];
    const target = Math.floor((elapsedMs / 1_000) * eventsPerSecond);
    const emitCount = Math.min(5_000, Math.max(0, target - emittedTarget));
    for (let index = 0; index < emitCount; index += 1) {
      const event = createEmission();
      counters.generatedEmissions += 1;
      phaseRecord.generated += 1;
      await acceptEmission(event, phaseRecord);
      emittedTarget += 1;
    }
    await releaseUpstream(phaseRecord);
    await heartbeatAndRecover(elapsedMs);
    const sample = captureSample(elapsedMs, phase.name);
    if (elapsedMs >= nextReportAt) {
      console.log(
        `${new Date().toISOString()} simulated=${Math.floor(elapsedMs / 1000)}s ` +
        `generated=${counters.generatedEmissions} accepted=${counters.acceptedByMonitor} ` +
        `upstream=${upstreamQueue.length} pending=${sample.pendingRows} replay=${sample.replayState} ` +
        `rssMiB=${(sample.rssBytes / 1_048_576).toFixed(1)}`,
      );
      persistReport("running", adapter.getOperatorSnapshot());
      nextReportAt = elapsedMs + reportIntervalMs;
    }
    await delay(50);
  }

  await setPhase(FAULT_PHASES.at(-1));
  const drainStarted = Date.now();
  while (!stopped) {
    const phaseRecord = phaseEvidence.final_recovery_and_drain;
    await releaseUpstream(phaseRecord);
    const drainElapsedMs = durationMs + Math.floor((Date.now() - drainStarted) * timeScale);
    await heartbeatAndRecover(drainElapsedMs);
    const snapshot = adapter.getOperatorSnapshot();
    captureSample(durationMs, "final_recovery_and_drain");
    if (
      upstreamQueue.length === 0 &&
      snapshot.backlog.totalRows === 0 &&
      snapshot.replay.state === "idle"
    ) break;
    if (Date.now() - drainStarted > drainTimeoutMs / timeScale) {
      throw new Error("Final recovery did not drain before --drain-timeout.");
    }
    await delay(50);
  }

  const finalSnapshot = adapter.getOperatorSnapshot();
  const requiredPhases = FAULT_PHASES.filter((phase) => phase.offline.length > 0);
  for (const phase of requiredPhases) {
    assert.equal(phaseEvidence[phase.name].entered, true, `missing phase ${phase.name}`);
    assert.ok(phaseEvidence[phase.name].samples > 0, `no samples for ${phase.name}`);
  }
  assert.equal(upstreamQueue.length, 0, "upstream retry queue must drain");
  assert.equal(finalSnapshot.backlog.totalRows, 0, "monitor backlog must drain");
  assert.equal(finalSnapshot.replay.state, "idle", "replay must return to idle");
  assert.equal(counters.indeterminateFailures, 0, "no adapter completion may be indeterminate");
  assert.ok(counters.replayDeliveriesThroughDedupe > 0, "recovery replay must pass through dedupe");
  assert.ok(counters.maximumRssBytes <= maxRssMb * 1_048_576, "RSS exceeded --max-rss-mb");
  assert.ok(counters.maximumWalBytes <= maxWalMb * 1_048_576, "WAL exceeded --max-wal-mb");
  assert.ok(counters.maximumPendingRows <= maxPendingRows, "pending rows exceeded --max-pending-rows");
  persistReport("passed", finalSnapshot);
  console.log(`combined wall-clock validation passed: ${outputPath}`);
}

process.once("SIGINT", () => {
  stopped = true;
  console.log("SIGINT received; stopping after the current validation step.");
});
process.once("SIGTERM", () => {
  stopped = true;
  console.log("SIGTERM received; stopping after the current validation step.");
});

try {
  await main();
} catch (error) {
  fatalError = error instanceof Error ? error : new Error(String(error));
  persistReport("failed", (() => {
    try { return adapter.getOperatorSnapshot(); } catch { return null; }
  })());
  console.error(fatalError);
  process.exitCode = 1;
} finally {
  adapter.close();
}

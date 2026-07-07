import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TransportMonitorAdapter } from "../.build/src/index.js";

const FOUR_HOURS_MS = 4n * 60n * 60n * 1000n;
const SIX_HOURS_MS = 6n * 60n * 60n * 1000n;
const NODE_IDS = [
  "edge-a",
  "edge-b",
  "edge-c",
  "edge-d",
  "edge-e",
  "edge-f",
  "edge-g",
  "edge-h",
];
const NODE_JITTER_MS = [0n, 17n, 31n, 43n, 59n, 71n, 89n, 113n];

function createEvent(nodeId, sequence, ingestedAt) {
  return {
    id: `${nodeId}-${sequence.toString().padStart(8, "0")}`,
    nodeId,
    clock: {
      physicalTimeMs: ingestedAt,
      logicalCounter: BigInt(sequence),
      nodeId,
    },
    sequence: BigInt(sequence),
    traceId: `trace-${nodeId}-${sequence}`,
    ingestedAt,
    payload: {
      traceId: `trace-${nodeId}-${sequence}`,
      entityId: `entity-${sequence}`,
      kind: "threshold-validation",
      operation: "upsert",
    },
  };
}

function toHttpStatus(decision) {
  switch (decision.action) {
    case "pause":
      return 503;
    case "accept":
    case "buffer_only":
      return 202;
    default:
      throw new Error(`Unsupported monitor action: ${decision.action}`);
  }
}

function createAdapter(databasePath, nowRef) {
  return new TransportMonitorAdapter(
    {
      deliverToDedupe: async () => {},
      deliverToOrder: async () => {},
    },
    {
      now: () => nowRef.value,
      reservoir: {
        databasePath,
        rollingBufferWindowMs: FOUR_HOURS_MS,
        fullOutageMaxWindowMs: SIX_HOURS_MS,
        pruneIntervalMs: 60_000n,
      },
      replay: {
        healthConfirmationHeartbeats: 1,
        pauseLiveFlowDuringReplay: true,
        retryBackoffMs: 5_000n,
      },
    },
  );
}

function setComponentState(adapter, component, state, observedAt) {
  adapter.updateComponentHealth(component, {
    state,
    observedAt,
    details: {
      source: "http-thresholds-8nodes",
    },
  });
}

function setAllOnline(adapter, observedAt) {
  setComponentState(adapter, "transport", "online", observedAt);
  setComponentState(adapter, "dedupe", "online", observedAt);
  setComponentState(adapter, "causal-order", "online", observedAt);
}

async function ingestBurst(adapter, nowRef, sequenceRef, atMs, label) {
  nowRef.value = atMs;
  const results = [];

  for (let index = 0; index < NODE_IDS.length; index += 1) {
    const nodeId = NODE_IDS[index];
    const ingestedAt = atMs + NODE_JITTER_MS[index];
    nowRef.value = ingestedAt;
    const sequence = sequenceRef.value;
    sequenceRef.value += 1;
    const result = await adapter.ingest(createEvent(nodeId, sequence, ingestedAt));
    results.push({
      label,
      nodeId,
      sequence,
      atMs: ingestedAt.toString(),
      action: result.decision.action,
      routingMode: result.decision.routingMode,
      deliveryMode: result.decision.deliveryMode,
      throttleTier: result.decision.throttleTier,
      httpStatus: toHttpStatus(result.decision),
      reason: result.decision.reason,
      forwardedTo: result.forwardedTo,
    });
  }

  return results;
}

function assertBurst(results, expected) {
  for (const result of results) {
    assert.equal(result.action, expected.action);
    assert.equal(result.routingMode, expected.routingMode);
    assert.equal(result.httpStatus, expected.httpStatus);
  }
}

async function drainReplay(adapter, limit = 100) {
  let iterations = 0;
  while (iterations < 20) {
    iterations += 1;
    const step = await adapter.reconcileRecovery(limit);
    if (step === null) {
      return;
    }
    if (step.completed && adapter.getSnapshot().reservoir.totalPendingRows === 0) {
      return;
    }
  }

  throw new Error("Replay drain did not complete within the expected number of passes.");
}

async function runOrderOutageScenario(workspace) {
  const nowRef = { value: 0n };
  const sequenceRef = { value: 1 };
  const adapter = createAdapter(join(workspace, "order-outage.sqlite"), nowRef);

  try {
    setAllOnline(adapter, nowRef.value);
    setComponentState(adapter, "causal-order", "offline", nowRef.value);

    const initialBurst = await ingestBurst(
      adapter,
      nowRef,
      sequenceRef,
      0n,
      "order_outage_initial",
    );
    assertBurst(initialBurst, {
      action: "buffer_only",
      routingMode: "order_buffer_only",
      httpStatus: 202,
    });
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 8);

    const fourHourBurst = await ingestBurst(
      adapter,
      nowRef,
      sequenceRef,
      FOUR_HOURS_MS + 5n * 60n * 1000n,
      "order_outage_after_4h",
    );
    assertBurst(fourHourBurst, {
      action: "buffer_only",
      routingMode: "order_buffer_only",
      httpStatus: 202,
    });

    nowRef.value = FOUR_HOURS_MS + 5n * 60n * 1000n + 1_000n;
    const pruneResult = adapter.getRuntime().pruneReservoir();
    assert.equal(pruneResult.markedDeadLetter, 8);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 8);

    setComponentState(adapter, "causal-order", "online", nowRef.value);
    await drainReplay(adapter);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);

    return {
      scenario: "order_outage_4h_window",
      nodeCount: NODE_IDS.length,
      initialBurst,
      fourHourBurst,
      pruneResult,
      finalReplayState: adapter.getReplaySnapshot().state,
      finalPendingRows: adapter.getSnapshot().reservoir.totalPendingRows,
    };
  } finally {
    adapter.close();
  }
}

async function runDualOutageScenario(workspace) {
  const nowRef = { value: 0n };
  const sequenceRef = { value: 1 };
  const adapter = createAdapter(join(workspace, "dual-outage.sqlite"), nowRef);

  try {
    setAllOnline(adapter, nowRef.value);
    setComponentState(adapter, "dedupe", "offline", nowRef.value);
    setComponentState(adapter, "causal-order", "offline", nowRef.value);

    const initialBurst = await ingestBurst(
      adapter,
      nowRef,
      sequenceRef,
      0n,
      "dual_outage_initial",
    );
    assertBurst(initialBurst, {
      action: "buffer_only",
      routingMode: "full_outage_buffer",
      httpStatus: 202,
    });
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 8);

    const sixHourBurst = await ingestBurst(
      adapter,
      nowRef,
      sequenceRef,
      SIX_HOURS_MS + 5n * 60n * 1000n,
      "dual_outage_after_6h",
    );
    assertBurst(sixHourBurst, {
      action: "buffer_only",
      routingMode: "full_outage_buffer",
      httpStatus: 202,
    });

    nowRef.value = SIX_HOURS_MS + 5n * 60n * 1000n + 1_000n;
    const pruneResult = adapter.getRuntime().pruneReservoir();
    assert.equal(pruneResult.markedDeadLetter, 8);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 8);

    setComponentState(adapter, "dedupe", "online", nowRef.value);
    setComponentState(adapter, "causal-order", "online", nowRef.value);
    await drainReplay(adapter);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);

    return {
      scenario: "dual_outage_6h_ceiling",
      nodeCount: NODE_IDS.length,
      initialBurst,
      sixHourBurst,
      pruneResult,
      finalReplayState: adapter.getReplaySnapshot().state,
      finalPendingRows: adapter.getSnapshot().reservoir.totalPendingRows,
    };
  } finally {
    adapter.close();
  }
}

async function runProtectiveStopScenario(workspace) {
  const nowRef = { value: 0n };
  const sequenceRef = { value: 1 };
  const adapter = createAdapter(join(workspace, "protective-stop.sqlite"), nowRef);

  try {
    setAllOnline(adapter, nowRef.value);
    setComponentState(adapter, "dedupe", "offline", nowRef.value);
    setComponentState(adapter, "causal-order", "offline", nowRef.value);

    for (let index = 0; index < 10_000; index += 1) {
      const nodeId = NODE_IDS[index % NODE_IDS.length];
      const jitter = NODE_JITTER_MS[index % NODE_JITTER_MS.length];
      const ingestedAt = nowRef.value + jitter;
      adapter.getRuntime().ingestTransportEvent(
        createEvent(nodeId, sequenceRef.value, ingestedAt),
      );
      sequenceRef.value += 1;
    }

    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 10_000);

    setComponentState(adapter, "causal-order", "online", nowRef.value + 1_000n);
    const pauseDecision = adapter.getRuntime().getIngressDecision();
    assert.equal(pauseDecision.routingMode, "dedupe_bypass_throttled");
    assert.equal(pauseDecision.action, "pause");
    assert.equal(toHttpStatus(pauseDecision), 503);

    return {
      scenario: "dedupe_bypass_protective_stop",
      nodeCount: NODE_IDS.length,
      pendingRowsBeforeDecision: adapter.getSnapshot().reservoir.totalPendingRows,
      action: pauseDecision.action,
      routingMode: pauseDecision.routingMode,
      throttleTier: pauseDecision.throttleTier,
      httpStatus: toHttpStatus(pauseDecision),
      reason: pauseDecision.reason,
    };
  } finally {
    adapter.close();
  }
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-http-thresholds-8nodes-"));
const reportDir = resolve("artifacts", "validation");
mkdirSync(reportDir, { recursive: true });

try {
  const report = {
    generatedAt: new Date().toISOString(),
    nodeIds: NODE_IDS,
    nodeJitterMs: NODE_JITTER_MS.map((value) => value.toString()),
    httpMapping: {
      accept: 202,
      buffer_only: 202,
      pause: 503,
    },
    scenarios: [
      await runOrderOutageScenario(workspace),
      await runDualOutageScenario(workspace),
      await runProtectiveStopScenario(workspace),
    ],
  };

  const reportPath = join(reportDir, "monitor-http-thresholds-8nodes.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(
    `http thresholds passed: validated 8-node 4h/6h buffering semantics and 202/503 mapping (${reportPath})`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { TransportMonitorAdapter } from "../.build/src/index.js";

const SIX_HOURS_MS = 6n * 60n * 60n * 1000n;

function createEvent(id, ingestedAt) {
  return {
    id,
    nodeId: "edge-a",
    clock: {
      physicalTimeMs: ingestedAt,
      logicalCounter: 0n,
      nodeId: "edge-a",
    },
    sequence: 1n,
    traceId: `trace-${id}`,
    ingestedAt,
    payload: {
      traceId: `trace-${id}`,
      entityId: id,
      kind: "retention-admission-contract",
    },
  };
}

function toHttpStatus(decision) {
  switch (decision.action) {
    case "accept":
    case "buffer_only":
      return 202;
    case "pause":
      return 503;
    default:
      throw new Error(`Unsupported monitor action: ${decision.action}`);
  }
}

function getReplayStateCount(databasePath, replayState) {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM ingress_events
           WHERE replay_state = ?`,
      )
      .get(replayState);
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

async function runFullOutageContractScenario() {
  const workspace = mkdtempSync(join(tmpdir(), "monitor-retention-contract-"));
  const databasePath = join(workspace, "monitor.sqlite");
  let nowMs = 0n;

  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async () => {},
      deliverToOrder: async () => {},
    },
    {
      now: () => nowMs,
      reservoir: {
        databasePath,
        rollingBufferWindowMs: 1_000n,
        fullOutageMaxWindowMs: 6_000n,
        pruneIntervalMs: 100n,
        pruneBatchSize: 10,
      },
    },
  );

  try {
    adapter.updateComponentHealth("transport", {
      state: "online",
      observedAt: nowMs,
      details: {},
    });
    adapter.updateComponentHealth("dedupe", {
      state: "offline",
      observedAt: nowMs,
      details: {},
    });
    adapter.updateComponentHealth("causal-order", {
      state: "offline",
      observedAt: nowMs,
      details: {},
    });

    const initialIngress = await adapter.ingest(createEvent("evt-1", nowMs));
    assert.equal(initialIngress.decision.routingMode, "full_outage_buffer");
    assert.equal(initialIngress.decision.action, "buffer_only");
    assert.equal(toHttpStatus(initialIngress.decision), 202);
    assert.notEqual(toHttpStatus(initialIngress.decision), 429);

    nowMs = 6_500n;

    const ingressPastCeiling = await adapter.ingest(createEvent("evt-2", nowMs));
    assert.equal(ingressPastCeiling.decision.routingMode, "full_outage_buffer");
    assert.equal(ingressPastCeiling.decision.action, "buffer_only");
    assert.equal(toHttpStatus(ingressPastCeiling.decision), 202);
    assert.notEqual(toHttpStatus(ingressPastCeiling.decision), 429);

    const pendingBeforePrune = adapter.getSnapshot().reservoir.totalPendingRows;
    assert.equal(pendingBeforePrune, 2);

    const pruneResult = adapter.getRuntime().pruneReservoir();
    assert.equal(pruneResult.markedDeadLetter, 1);
    assert.equal(pruneResult.deletedRows, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);
    assert.equal(getReplayStateCount(databasePath, "dead_letter"), 0);
    assert.equal(getReplayStateCount(databasePath, "pending"), 1);
  } finally {
    adapter.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function runProtectiveStopContractScenario() {
  const workspace = mkdtempSync(join(tmpdir(), "monitor-admission-contract-"));
  const databasePath = join(workspace, "monitor.sqlite");
  let nowMs = 0n;

  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async () => {},
      deliverToOrder: async () => {},
    },
    {
      now: () => nowMs,
      reservoir: {
        databasePath,
        rollingBufferWindowMs: 1_000n,
        fullOutageMaxWindowMs: SIX_HOURS_MS,
        pruneIntervalMs: 100n,
        pruneBatchSize: 250,
      },
    },
  );

  try {
    adapter.updateComponentHealth("transport", {
      state: "online",
      observedAt: nowMs,
      details: {},
    });
    adapter.updateComponentHealth("dedupe", {
      state: "offline",
      observedAt: nowMs,
      details: {},
    });
    adapter.updateComponentHealth("causal-order", {
      state: "online",
      observedAt: nowMs,
      details: {},
    });

    for (let index = 0; index < 10_000; index += 1) {
      const decision = adapter.getRuntime().ingestTransportEvent(
        createEvent(`pause-${index}`, nowMs + BigInt(index)),
      ).decision;
      assert.notEqual(toHttpStatus(decision), 429);
    }

    const pauseDecision = adapter.getRuntime().getIngressDecision();
    assert.equal(pauseDecision.routingMode, "dedupe_bypass_throttled");
    assert.equal(pauseDecision.action, "pause");
    assert.equal(toHttpStatus(pauseDecision), 503);
    assert.notEqual(toHttpStatus(pauseDecision), 429);
  } finally {
    adapter.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

await runFullOutageContractScenario();
await runProtectiveStopContractScenario();

console.log(
  "retention admission contract passed: 202/503 mapping, no 429 usage, prune-driven hard cutoff, and dead_letter evidence are enforced directly",
);

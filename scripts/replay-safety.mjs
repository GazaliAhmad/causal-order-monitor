import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TransportMonitorAdapter } from "../.build/src/index.js";

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
    traceId: "trace-1",
    ingestedAt,
    payload: {
      traceId: "trace-1",
      entityId: "entity-1",
      kind: "test",
    },
  };
}

async function runRetryWindowScenario() {
  const workspace = mkdtempSync(join(tmpdir(), "monitor-replay-safety-"));
  const databasePath = join(workspace, "monitor.sqlite");
  let nowMs = 0n;
  let replayAttempts = 0;

  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async (_event, context) => {
        if (!context.replay) {
          return;
        }

        replayAttempts += 1;
        if (replayAttempts === 1) {
          throw new Error("simulated replay delivery failure");
        }
      },
      deliverToOrder: async () => {},
    },
    {
      now: () => nowMs,
      reservoir: {
        databasePath,
        rollingBufferWindowMs: 1_000n,
        fullOutageMaxWindowMs: 6_000n,
        pruneIntervalMs: 100n,
      },
      replay: {
        healthConfirmationHeartbeats: 1,
        pauseLiveFlowDuringReplay: true,
        retryBackoffMs: 5_000n,
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
      state: "online",
      observedAt: nowMs,
      details: {},
    });
    adapter.updateComponentHealth("causal-order", {
      state: "offline",
      observedAt: nowMs,
      details: {},
    });

    const ingestResult = await adapter.ingest(createEvent("event-1", nowMs));
    assert.equal(ingestResult.forwardedTo, "buffer");
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);

    adapter.updateComponentHealth("causal-order", {
      state: "online",
      observedAt: nowMs,
      details: {},
    });

    const failedReplay = await adapter.reconcileRecovery(1);
    assert.ok(failedReplay);
    assert.equal(failedReplay.snapshot.state, "failed");
    assert.equal(replayAttempts, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);
    assert.equal(failedReplay.snapshot.nextRetryAt, 5_000n);

    nowMs = 2_000n;
    const pruneBeforeRetry = adapter.getRuntime().pruneReservoir();
    assert.equal(pruneBeforeRetry.markedDeadLetter, 0);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);

    const replayDuringBackoff = await adapter.reconcileRecovery(1);
    assert.equal(replayDuringBackoff, null);
    assert.equal(replayAttempts, 1);

    nowMs = 5_000n;
    const recoveredReplay = await adapter.reconcileRecovery(1);
    assert.ok(recoveredReplay);
    assert.equal(replayAttempts, 2);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
    assert.ok(
      recoveredReplay.snapshot.state === "completed" ||
        recoveredReplay.snapshot.state === "idle",
    );
  } finally {
    adapter.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function runHardCutoffScenario() {
  const workspace = mkdtempSync(join(tmpdir(), "monitor-replay-cutoff-"));
  const databasePath = join(workspace, "monitor.sqlite");
  let nowMs = 0n;
  let replayAttempts = 0;

  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe: async (_event, context) => {
        if (context.replay) {
          replayAttempts += 1;
          throw new Error("still failing");
        }
      },
      deliverToOrder: async () => {},
    },
    {
      now: () => nowMs,
      reservoir: {
        databasePath,
        rollingBufferWindowMs: 1_000n,
        fullOutageMaxWindowMs: 6_000n,
        pruneIntervalMs: 100n,
      },
      replay: {
        healthConfirmationHeartbeats: 1,
        pauseLiveFlowDuringReplay: true,
        retryBackoffMs: 5_000n,
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
      state: "online",
      observedAt: nowMs,
      details: {},
    });
    adapter.updateComponentHealth("causal-order", {
      state: "offline",
      observedAt: nowMs,
      details: {},
    });

    await adapter.ingest(createEvent("event-2", nowMs));
    adapter.updateComponentHealth("causal-order", {
      state: "online",
      observedAt: nowMs,
      details: {},
    });

    const failedReplay = await adapter.reconcileRecovery(1);
    assert.ok(failedReplay);
    assert.equal(failedReplay.snapshot.state, "failed");
    assert.equal(replayAttempts, 1);

    nowMs = 6_500n;
    const pruneAtHardCutoff = adapter.getRuntime().pruneReservoir();
    assert.equal(pruneAtHardCutoff.markedDeadLetter, 1);
    assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  } finally {
    adapter.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

await runRetryWindowScenario();
await runHardCutoffScenario();

console.log(
  "replay safety passed: retry-waiting rows survive rolling prune, do not replay early, and dead-letter only at hard cutoff",
);

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TransportMonitorAdapter,
  inspectMonitorSnapshot,
} from "../.build/src/index.js";

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

const workspace = mkdtempSync(join(tmpdir(), "monitor-inspect-snapshot-"));
const databasePath = join(workspace, "monitor.sqlite");
let nowMs = 0n;

const adapter = new TransportMonitorAdapter(
  {
    deliverToDedupe: async (_event, context) => {
      if (context.replay) {
        throw new Error("simulated replay failure");
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

  await adapter.ingest(createEvent("event-1", nowMs));

  let inspected = adapter.getInspectedSnapshot();
  assert.equal(inspected.operationalState, "buffering_only");
  assert.equal(inspected.liveFlowGateClosed, false);
  assert.equal(inspected.replayBacklogRemainingRows, 1);
  assert.equal(inspected.replayReadyRows, 1);
  assert.equal(inspected.requiresOperatorAttention, true);
  assert.deepEqual(inspected, inspectMonitorSnapshot(adapter.getSnapshot()));

  adapter.updateComponentHealth("causal-order", {
    state: "online",
    observedAt: nowMs,
    details: {},
  });

  await adapter.reconcileRecovery(1);

  inspected = adapter.getInspectedSnapshot();
  assert.equal(inspected.operationalState, "replay_retry_waiting");
  assert.equal(inspected.liveFlowGateClosed, true);
  assert.equal(inspected.liveFlowGateReason, "replay retry backoff in progress");
  assert.equal(inspected.replayRetryBackoffActive, true);
  assert.equal(inspected.retryWaitingRows, 1);
  assert.equal(inspected.replayReadyRows, 0);
  assert.equal(inspected.replayRetryDelayMs, 5_000n);
  assert.equal(inspected.replayConsecutiveFailureCount, 1);
  assert.deepEqual(inspected, inspectMonitorSnapshot(adapter.getSnapshot()));
} finally {
  adapter.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "inspect snapshot passed: derived operator state, live-flow gate reason, and retry timing are surfaced correctly",
);

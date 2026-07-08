import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MonitorRuntime,
  ReplayOwnershipError,
  TransportMonitorAdapter,
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
    traceId: `trace-${id}`,
    ingestedAt,
    payload: {
      traceId: `trace-${id}`,
      entityId: "entity-1",
      kind: "test",
    },
  };
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-replay-ownership-"));
let nowMs = 0n;

const adapter = new TransportMonitorAdapter(
  {
    deliverToDedupe: async () => {},
    deliverToOrder: async () => {},
  },
  {
    now: () => nowMs,
    reservoir: {
      databasePath: join(workspace, "adapter.sqlite"),
      rollingBufferWindowMs: 10_000n,
      fullOutageMaxWindowMs: 20_000n,
      pruneIntervalMs: 100n,
    },
    replay: {
      healthConfirmationHeartbeats: 1,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 1_000n,
    },
  },
);

const manualRuntime = new MonitorRuntime({
  now: () => nowMs,
  reservoir: {
    databasePath: join(workspace, "manual.sqlite"),
    rollingBufferWindowMs: 10_000n,
    fullOutageMaxWindowMs: 20_000n,
    pruneIntervalMs: 100n,
  },
});

try {
  let thrownError = null;
  try {
    adapter.getRuntime().queueReplay();
  } catch (error) {
    thrownError = error;
  }

  assert.ok(thrownError instanceof Error);
  assert.ok(thrownError instanceof ReplayOwnershipError);
  assert.equal(thrownError.code, "ERR_MONITOR_REPLAY_OWNERSHIP");
  assert.match(
    thrownError.message,
    /adapter-managed runtime/i,
  );

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

  adapter.updateComponentHealth("causal-order", {
    state: "online",
    observedAt: nowMs,
    details: {},
  });

  const replayResult = await adapter.reconcileRecovery(1);
  assert.ok(replayResult !== null);
  assert.equal(replayResult.deliveredCount, 1);

  const manualSnapshot = manualRuntime.queueReplay();
  assert.equal(manualSnapshot.state, "idle");
} finally {
  adapter.close();
  manualRuntime.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "replay ownership guard passed: adapter-managed runtimes reject manual replay control while standalone runtimes still allow manual orchestration",
);

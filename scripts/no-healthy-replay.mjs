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
    traceId: "trace-healthy",
    ingestedAt,
    payload: {
      traceId: "trace-healthy",
      entityId: "entity-healthy",
      kind: "test",
    },
  };
}

const workspace = mkdtempSync(join(tmpdir(), "monitor-no-healthy-replay-"));
const databasePath = join(workspace, "monitor.sqlite");
let nowMs = 0n;
let releaseDelivery;
let deliveryBlocked = createBlockedDelivery();

function createBlockedDelivery() {
  return new Promise((resolve) => {
    releaseDelivery = resolve;
  });
}

const adapter = new TransportMonitorAdapter(
  {
    deliverToDedupe: async () => {
      await deliveryBlocked;
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
      healthConfirmationHeartbeats: 3,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 5_000n,
    },
  },
);

try {
  for (const component of ["transport", "dedupe", "causal-order"]) {
    adapter.updateComponentHealth(component, {
      state: "online",
      observedAt: nowMs,
      details: {},
    });
  }

  const ingestPromise = adapter.ingest(createEvent("event-live-1", nowMs));

  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);
  assert.equal(adapter.getReplaySnapshot().state, "idle");

  adapter.observeHeartbeat("dedupe", nowMs, {
    scenario: "healthy-live-flow",
  });
  adapter.observeHeartbeat("causal-order", nowMs, {
    scenario: "healthy-live-flow",
  });

  assert.equal(adapter.getReplaySnapshot().state, "idle");
  assert.equal(adapter.getSnapshot().routingMode, "normal");
  assert.equal(await adapter.reconcileRecovery(1), null);
  assert.equal(adapter.getReplaySnapshot().state, "idle");

  releaseDelivery();
  const ingestResult = await ingestPromise;

  assert.equal(ingestResult.forwardedTo, "dedupe");
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  assert.equal(adapter.getReplaySnapshot().state, "idle");

  adapter.updateComponentHealth("causal-order", {
    state: "offline",
    observedAt: nowMs,
    details: {
      scenario: "real-outage-then-recovery",
    },
  });

  const bufferedResult = await adapter.ingest(createEvent("event-outage-1", nowMs));
  assert.equal(bufferedResult.forwardedTo, "buffer");
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);

  adapter.updateComponentHealth("causal-order", {
    state: "online",
    observedAt: nowMs,
    details: {
      scenario: "real-outage-then-recovery",
    },
  });

  assert.equal(await adapter.reconcileRecovery(1), null);

  const gatedRecoveryResult = await adapter.ingest(createEvent("event-recovery-gated-1", nowMs));
  assert.equal(gatedRecoveryResult.forwardedTo, "buffer");
  assert.match(
    gatedRecoveryResult.decision.reason,
    /recovery confirmation holding live flow before replay start/i,
  );

  adapter.observeHeartbeat("dedupe", nowMs, {
    scenario: "pre-replay-confirmation-heartbeat-1",
  });
  adapter.observeHeartbeat("causal-order", nowMs, {
    scenario: "pre-replay-confirmation-heartbeat-2",
  });
  const recoveredReplay = await adapter.reconcileRecovery(2);
  assert.ok(recoveredReplay);
  assert.ok(
    recoveredReplay.snapshot.state === "completed" ||
      recoveredReplay.snapshot.state === "idle",
  );
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);

  const gatedLiveResult = await adapter.ingest(createEvent("event-live-2", nowMs));
  assert.equal(gatedLiveResult.forwardedTo, "buffer");
  assert.equal(
    adapter.getSnapshot().reservoir.pendingRowsByDeliveryMode.replay_through_dedupe,
    1,
  );
  assert.equal(adapter.getReplaySnapshot().state, "completed");

  adapter.observeHeartbeat("dedupe", nowMs, {
    scenario: "post-recovery-heartbeat-1",
  });
  adapter.observeHeartbeat("causal-order", nowMs, {
    scenario: "post-recovery-heartbeat-2",
  });
  adapter.observeHeartbeat("dedupe", nowMs, {
    scenario: "post-recovery-heartbeat-3",
  });
  const gatedReplay = await adapter.reconcileRecovery(1);
  assert.ok(gatedReplay);
  assert.ok(
    gatedReplay.snapshot.state === "completed" ||
      gatedReplay.snapshot.state === "idle",
  );
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);

  adapter.observeHeartbeat("dedupe", nowMs, {
    scenario: "post-gated-replay-heartbeat-1",
  });
  adapter.observeHeartbeat("causal-order", nowMs, {
    scenario: "post-gated-replay-heartbeat-2",
  });
  adapter.observeHeartbeat("dedupe", nowMs, {
    scenario: "post-gated-replay-heartbeat-3",
  });
  assert.equal(adapter.getReplaySnapshot().state, "idle");

  deliveryBlocked = createBlockedDelivery();
  const healthyLiveFlowPromise = adapter.ingest(createEvent("event-live-3", nowMs));

  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 1);
  assert.equal(adapter.getSnapshot().reservoir.pendingRowsByDeliveryMode.normal, 1);
  assert.equal(await adapter.reconcileRecovery(1), null);
  assert.equal(adapter.getReplaySnapshot().state, "idle");

  releaseDelivery();
  const healthyLiveFlowResult = await healthyLiveFlowPromise;
  assert.equal(healthyLiveFlowResult.forwardedTo, "dedupe");
  assert.equal(adapter.getSnapshot().reservoir.totalPendingRows, 0);
  assert.equal(adapter.getReplaySnapshot().state, "idle");
} finally {
  adapter.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "healthy replay guard passed: healthy in-flight rows do not auto-queue replay",
);

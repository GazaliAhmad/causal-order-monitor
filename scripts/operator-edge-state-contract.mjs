import assert from "node:assert/strict";

import { inspectMonitorSnapshotV1 } from "../.build/src/index.js";

const generatedAt = 20_000n;

function component(componentName, state = "online") {
  return {
    component: componentName,
    state,
    observedAt: generatedAt,
    lastChangedAt: 10_000n,
    reasonCode: state === "online" ? null : `${componentName.toUpperCase()}_UNAVAILABLE`,
    details: {},
  };
}

const baseSnapshot = {
  generatedAt,
  routingMode: "normal",
  throttleTier: "open",
  components: {
    transport: component("transport"),
    dedupe: component("dedupe"),
    "causal-order": component("causal-order"),
  },
  reservoir: {
    totalPendingRows: 0,
    oldestPendingAgeMs: 0n,
    retryWaitingRows: 0,
    earliestRetryAt: null,
    pendingRowsBySourcePath: {
      transport_normalized_stream: 0,
      deduped_observation: 0,
    },
    pendingRowsByDeliveryMode: {},
  },
  replay: {
    state: "idle",
    targetPath: "dedupe_then_order",
    queuedEventCount: 0,
    deliveredEventCount: 0,
    startedAt: null,
    endedAt: null,
    lastError: null,
    nextRetryAt: null,
    consecutiveFailureCount: 0,
    recoveryHeartbeatCount: 0,
    requiredRecoveryHeartbeats: 2,
  },
};

const normalStorage = {
  pressure: "normal",
  databaseBytes: "4096",
  walBytes: "0",
  filesystemAvailableBytes: "800000",
  filesystemTotalBytes: "1000000",
  filesystemUsedPercent: 20,
};

function createSnapshot(overrides = {}) {
  return {
    ...baseSnapshot,
    ...overrides,
    components: {
      ...baseSnapshot.components,
      ...overrides.components,
    },
    reservoir: {
      ...baseSnapshot.reservoir,
      ...overrides.reservoir,
    },
    replay: {
      ...baseSnapshot.replay,
      ...overrides.replay,
    },
  };
}

const replayBacklog = {
  totalPendingRows: 2,
  oldestPendingAgeMs: 10_000n,
  pendingRowsBySourcePath: {
    transport_normalized_stream: 2,
    deduped_observation: 0,
  },
  pendingRowsByDeliveryMode: { order_buffer: 2 },
};

const cases = [
  {
    name: "healthy empty reservoir",
    snapshot: createSnapshot(),
    expected: ["healthy", "none", false, "accepted_live", "MONITOR_LIVE_FLOW_AVAILABLE"],
  },
  {
    name: "degraded live flow",
    snapshot: createSnapshot({
      routingMode: "dedupe_bypass_throttled",
      throttleTier: "slow",
      components: { dedupe: component("dedupe", "offline") },
    }),
    expected: ["degraded", "restore_affected_components", false, "accepted_live", "MONITOR_LIVE_FLOW_AVAILABLE"],
    affectedComponents: ["dedupe"],
  },
  {
    name: "outage buffering",
    snapshot: createSnapshot({
      routingMode: "order_buffer_only",
      throttleTier: "paused",
      components: { "causal-order": component("causal-order", "offline") },
      reservoir: replayBacklog,
    }),
    expected: ["buffering", "restore_affected_components", false, "accepted_buffered", "MONITOR_OUTAGE_BUFFERING"],
    affectedComponents: ["causal-order"],
  },
  {
    name: "pre-replay recovery confirmation",
    snapshot: createSnapshot({ reservoir: replayBacklog }),
    expected: ["recovering", "monitor_replay", true, "accepted_buffered", "MONITOR_RECOVERY_GATE_BUFFERING"],
  },
  ...["queued", "running"].map((state) => ({
    name: `${state} replay`,
    snapshot: createSnapshot({
      routingMode: "replay_through_dedupe",
      reservoir: replayBacklog,
      replay: { state, queuedEventCount: 2, startedAt: state === "running" ? 19_000n : null },
    }),
    expected: ["recovering", "monitor_replay", true, "accepted_buffered", "MONITOR_RECOVERY_GATE_BUFFERING"],
    affectedComponents: ["replay"],
  })),
  {
    name: "failed replay in active backoff",
    snapshot: createSnapshot({
      routingMode: "replay_through_dedupe",
      reservoir: { ...replayBacklog, retryWaitingRows: 2, earliestRetryAt: 21_000n },
      replay: {
        state: "failed",
        queuedEventCount: 2,
        endedAt: 19_000n,
        lastError: "delivery failed",
        nextRetryAt: 21_000n,
        consecutiveFailureCount: 1,
      },
    }),
    expected: ["recovering", "wait_for_retry", true, "accepted_buffered", "MONITOR_RECOVERY_GATE_BUFFERING"],
    affectedComponents: ["replay"],
  },
  {
    name: "failed replay after retry deadline",
    snapshot: createSnapshot({
      routingMode: "replay_through_dedupe",
      reservoir: replayBacklog,
      replay: {
        state: "failed",
        queuedEventCount: 2,
        endedAt: 18_000n,
        lastError: "delivery failed",
        nextRetryAt: 19_000n,
        consecutiveFailureCount: 1,
      },
    }),
    expected: ["attention_required", "inspect_replay_failure", true, "accepted_buffered", "MONITOR_RECOVERY_GATE_BUFFERING"],
    affectedComponents: ["replay"],
  },
  {
    name: "post-replay confirmation",
    snapshot: createSnapshot({
      replay: {
        state: "completed",
        queuedEventCount: 2,
        deliveredEventCount: 2,
        startedAt: 18_000n,
        endedAt: 19_000n,
      },
    }),
    expected: ["recovering", "monitor_replay", true, "accepted_buffered", "MONITOR_RECOVERY_GATE_BUFFERING"],
  },
  {
    name: "aborted replay",
    snapshot: createSnapshot({
      reservoir: replayBacklog,
      replay: {
        state: "aborted",
        queuedEventCount: 2,
        endedAt: 19_000n,
        lastError: "operator abort",
      },
    }),
    expected: ["attention_required", "inspect_replay_failure", false, "accepted_live", "MONITOR_LIVE_FLOW_AVAILABLE"],
    affectedComponents: ["replay"],
  },
  {
    name: "protective refusal",
    snapshot: createSnapshot({ throttleTier: "paused" }),
    expected: ["protective_refusal", "relieve_protective_pressure", false, "protective_refusal", "MONITOR_PROTECTIVE_THROTTLE"],
  },
];

for (const testCase of cases) {
  const operator = inspectMonitorSnapshotV1(testCase.snapshot, normalStorage);
  const [status, action, gateClosed, posture, reasonCode] = testCase.expected;
  assert.equal(operator.status, status, `${testCase.name}: status`);
  assert.equal(operator.recommendedAction, action, `${testCase.name}: action`);
  assert.equal(operator.replay.gateClosed, gateClosed, `${testCase.name}: gate`);
  assert.equal(operator.admission.posture, posture, `${testCase.name}: posture`);
  assert.equal(operator.admission.reasonCode, reasonCode, `${testCase.name}: reason`);
  assert.deepEqual(
    operator.affectedComponents,
    testCase.affectedComponents ?? [],
    `${testCase.name}: affected components`,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(operator)), operator, `${testCase.name}: JSON round trip`);
}

for (const [pressure, status, action] of [
  ["elevated", "degraded", "free_local_storage"],
  ["critical", "attention_required", "free_local_storage"],
]) {
  const operator = inspectMonitorSnapshotV1(createSnapshot(), {
    ...normalStorage,
    pressure,
  });
  assert.equal(operator.status, status, `${pressure} storage: status`);
  assert.equal(operator.recommendedAction, action, `${pressure} storage: action`);
  assert.deepEqual(operator.affectedComponents, ["reservoir"]);
}

console.log(
  `operator edge-state contract passed: ${cases.length + 2} deterministic status, gate, admission, and storage mappings`,
);

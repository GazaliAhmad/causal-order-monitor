import type {
  InspectedMonitorSnapshot,
  MonitorOperatorSnapshotV1,
  MonitorSnapshot,
  MonitorStorageSnapshotV1,
} from "../types/snapshots.js";

function deriveOperationalState(
  snapshot: MonitorSnapshot,
  replayRetryBackoffActive: boolean,
  preReplayRecoveryConfirmationActive: boolean,
): InspectedMonitorSnapshot["operationalState"] {
  if (replayRetryBackoffActive) {
    return "replay_retry_waiting";
  }

  if (preReplayRecoveryConfirmationActive) {
    return "recovery_confirming";
  }

  if (snapshot.replay.state === "queued" || snapshot.replay.state === "running") {
    return "replay_draining";
  }

  if (snapshot.replay.state === "completed") {
    return "recovery_confirming";
  }

  if (
    snapshot.routingMode === "order_buffer_only" ||
    snapshot.routingMode === "full_outage_buffer"
  ) {
    return "buffering_only";
  }

  if (snapshot.routingMode === "dedupe_bypass_throttled") {
    return "degraded_live";
  }

  return "healthy_live";
}

function deriveLiveFlowGateReason(
  snapshot: MonitorSnapshot,
  replayRetryBackoffActive: boolean,
  preReplayRecoveryConfirmationActive: boolean,
): string | null {
  if (replayRetryBackoffActive) {
    return "replay retry backoff in progress";
  }

  if (preReplayRecoveryConfirmationActive) {
    return "pre-replay health confirmation is still in progress";
  }

  if (snapshot.replay.state === "queued" || snapshot.replay.state === "running") {
    return "replay backlog is draining";
  }

  if (snapshot.replay.state === "failed") {
    return "replay failure is awaiting retry";
  }

  if (snapshot.replay.state === "completed") {
    return "post-replay health confirmation is still in progress";
  }

  return null;
}

export function inspectMonitorSnapshot(
  snapshot: MonitorSnapshot,
): InspectedMonitorSnapshot {
  const unhealthyComponents = Object.values(snapshot.components)
    .filter((component) => component.state !== "online")
    .map((component) => component.component);
  const replayRetryBackoffActive =
    snapshot.replay.nextRetryAt !== null &&
    snapshot.replay.nextRetryAt > snapshot.generatedAt;
  const replayEligibleBacklog = Object.entries(
    snapshot.reservoir.pendingRowsByDeliveryMode,
  ).some(
    ([deliveryMode, count]) =>
      deliveryMode !== "normal" &&
      deliveryMode !== "dedupe_bypass" &&
      Number(count ?? 0) > 0,
  );
  const replayTargetsHealthy =
    snapshot.components.dedupe.state === "online" &&
    snapshot.components["causal-order"].state === "online";
  const preReplayRecoveryConfirmationActive =
    replayTargetsHealthy &&
    replayEligibleBacklog &&
    snapshot.replay.state === "idle" &&
    snapshot.replay.recoveryHeartbeatCount <
      snapshot.replay.requiredRecoveryHeartbeats;
  const operationalState = deriveOperationalState(
    snapshot,
    replayRetryBackoffActive,
    preReplayRecoveryConfirmationActive,
  );
  const liveFlowGateReason = deriveLiveFlowGateReason(
    snapshot,
    replayRetryBackoffActive,
    preReplayRecoveryConfirmationActive,
  );
  const liveFlowGateClosed = liveFlowGateReason !== null;
  const replayReadyRows = Math.max(
    0,
    snapshot.reservoir.totalPendingRows - snapshot.reservoir.retryWaitingRows,
  );
  const replayProgressBase =
    snapshot.replay.deliveredEventCount + snapshot.reservoir.totalPendingRows;
  const replayProgressPercent = replayProgressBase === 0
    ? null
    : Math.min(
        100,
        Math.max(
          0,
          Math.round(
            (snapshot.replay.deliveredEventCount / replayProgressBase) * 100,
          ),
        ),
      );
  const replayRetryDelayMs =
    snapshot.replay.nextRetryAt !== null &&
      snapshot.replay.nextRetryAt > snapshot.generatedAt
      ? snapshot.replay.nextRetryAt - snapshot.generatedAt
      : null;
  const requiresOperatorAttention =
    unhealthyComponents.length > 0 ||
    snapshot.replay.state === "failed" ||
    snapshot.replay.state === "aborted" ||
    snapshot.reservoir.retryWaitingRows > 0 ||
    snapshot.reservoir.totalPendingRows > 0;

  return {
    generatedAt: snapshot.generatedAt,
    operationalState,
    routingMode: snapshot.routingMode,
    throttleTier: snapshot.throttleTier,
    unhealthyComponents,
    requiresOperatorAttention,
    liveFlowGateClosed,
    liveFlowGateReason,
    totalPendingRows: snapshot.reservoir.totalPendingRows,
    oldestPendingAgeMs: snapshot.reservoir.oldestPendingAgeMs,
    replayReadyRows,
    retryWaitingRows: snapshot.reservoir.retryWaitingRows,
    earliestRetryAt: snapshot.reservoir.earliestRetryAt,
    replayState: snapshot.replay.state,
    replayBacklogRemainingRows: snapshot.reservoir.totalPendingRows,
    replayProgressPercent,
    replayQueuedEventCount: snapshot.replay.queuedEventCount,
    replayDeliveredEventCount: snapshot.replay.deliveredEventCount,
    replayNextRetryAt: snapshot.replay.nextRetryAt,
    replayRetryDelayMs,
    replayConsecutiveFailureCount: snapshot.replay.consecutiveFailureCount,
    replayRetryBackoffActive,
  };
}

const UNKNOWN_STORAGE: MonitorStorageSnapshotV1 = {
  pressure: "unknown",
  databaseBytes: null,
  walBytes: null,
  filesystemAvailableBytes: null,
  filesystemTotalBytes: null,
  filesystemUsedPercent: null,
};

export function inspectMonitorSnapshotV1(
  snapshot: MonitorSnapshot,
  storage: MonitorStorageSnapshotV1 = UNKNOWN_STORAGE,
): MonitorOperatorSnapshotV1 {
  const inspected = inspectMonitorSnapshot(snapshot);
  const buffering =
    snapshot.routingMode === "order_buffer_only" ||
    snapshot.routingMode === "full_outage_buffer" ||
    snapshot.routingMode === "replay_through_dedupe" ||
    inspected.liveFlowGateClosed;
  const protectiveRefusal = !buffering && snapshot.throttleTier === "paused";
  const admission = protectiveRefusal
    ? {
        posture: "protective_refusal" as const,
        accepted: false,
        httpStatus: 503 as const,
        reasonCode: "MONITOR_PROTECTIVE_THROTTLE" as const,
      }
    : buffering
      ? {
          posture: "accepted_buffered" as const,
          accepted: true,
          httpStatus: 202 as const,
          reasonCode: inspected.liveFlowGateClosed
            ? "MONITOR_RECOVERY_GATE_BUFFERING" as const
            : "MONITOR_OUTAGE_BUFFERING" as const,
        }
      : {
          posture: "accepted_live" as const,
          accepted: true,
          httpStatus: 202 as const,
          reasonCode: "MONITOR_LIVE_FLOW_AVAILABLE" as const,
        };
  const affectedComponents: MonitorOperatorSnapshotV1["affectedComponents"] = [
    ...inspected.unhealthyComponents,
  ];
  if (
    snapshot.replay.state === "failed" ||
    snapshot.replay.state === "aborted" ||
    snapshot.replay.state === "queued" ||
    snapshot.replay.state === "running" ||
    inspected.replayRetryBackoffActive
  ) {
    affectedComponents.push("replay");
  }
  if (storage.pressure === "elevated" || storage.pressure === "critical") {
    affectedComponents.push("reservoir");
  }

  let status: MonitorOperatorSnapshotV1["status"] = "healthy";
  let recommendedAction: MonitorOperatorSnapshotV1["recommendedAction"] = "none";
  if (storage.pressure === "critical") {
    status = "attention_required";
    recommendedAction = "free_local_storage";
  } else if (protectiveRefusal) {
    status = "protective_refusal";
    recommendedAction = "relieve_protective_pressure";
  } else if (inspected.replayRetryBackoffActive) {
    status = "recovering";
    recommendedAction = "wait_for_retry";
  } else if (snapshot.replay.state === "failed" || snapshot.replay.state === "aborted") {
    status = "attention_required";
    recommendedAction = "inspect_replay_failure";
  } else if (
    snapshot.replay.state === "queued" ||
    snapshot.replay.state === "running" ||
    snapshot.replay.state === "completed" ||
    inspected.liveFlowGateClosed
  ) {
    status = "recovering";
    recommendedAction = "monitor_replay";
  } else if (buffering) {
    status = "buffering";
    recommendedAction = "restore_affected_components";
  } else if (inspected.unhealthyComponents.length > 0) {
    status = "degraded";
    recommendedAction = "restore_affected_components";
  } else if (storage.pressure === "elevated") {
    status = "degraded";
    recommendedAction = "free_local_storage";
  }

  return {
    schema: "causal-order-monitor/operator-snapshot",
    version: 1,
    generatedAtMs: snapshot.generatedAt.toString(),
    status,
    affectedComponents: [...new Set(affectedComponents)],
    recommendedAction,
    routingMode: snapshot.routingMode,
    throttleTier: snapshot.throttleTier,
    admission,
    backlog: {
      totalRows: inspected.totalPendingRows,
      readyRows: inspected.replayReadyRows,
      retryWaitingRows: inspected.retryWaitingRows,
      oldestAgeMs: inspected.oldestPendingAgeMs.toString(),
      earliestRetryAtMs: inspected.earliestRetryAt?.toString() ?? null,
    },
    replay: {
      state: inspected.replayState,
      gateClosed: inspected.liveFlowGateClosed,
      backlogRemainingRows: inspected.replayBacklogRemainingRows,
      queuedEventCount: inspected.replayQueuedEventCount,
      deliveredEventCount: inspected.replayDeliveredEventCount,
      progressPercent: inspected.replayProgressPercent,
      consecutiveFailureCount: inspected.replayConsecutiveFailureCount,
      nextRetryAtMs: inspected.replayNextRetryAt?.toString() ?? null,
      retryDelayMs: inspected.replayRetryDelayMs?.toString() ?? null,
    },
    storage: { ...storage },
  };
}

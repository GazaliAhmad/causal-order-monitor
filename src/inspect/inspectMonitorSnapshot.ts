import type {
  InspectedMonitorSnapshot,
  MonitorSnapshot,
} from "../types/snapshots.js";

function deriveOperationalState(
  snapshot: MonitorSnapshot,
  replayRetryBackoffActive: boolean,
): InspectedMonitorSnapshot["operationalState"] {
  if (replayRetryBackoffActive) {
    return "replay_retry_waiting";
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
): string | null {
  if (replayRetryBackoffActive) {
    return "replay retry backoff in progress";
  }

  if (snapshot.replay.state === "queued" || snapshot.replay.state === "running") {
    return "replay backlog is draining";
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
  const operationalState = deriveOperationalState(
    snapshot,
    replayRetryBackoffActive,
  );
  const liveFlowGateReason = deriveLiveFlowGateReason(
    snapshot,
    replayRetryBackoffActive,
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

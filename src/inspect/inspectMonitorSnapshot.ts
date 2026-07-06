import type {
  InspectedMonitorSnapshot,
  MonitorSnapshot,
} from "../types/snapshots.js";

export function inspectMonitorSnapshot(
  snapshot: MonitorSnapshot,
): InspectedMonitorSnapshot {
  const unhealthyComponents = Object.values(snapshot.components)
    .filter((component) => component.state !== "online")
    .map((component) => component.component);
  const replayRetryBackoffActive =
    snapshot.replay.nextRetryAt !== null &&
    snapshot.replay.nextRetryAt > snapshot.generatedAt;

  return {
    generatedAt: snapshot.generatedAt,
    routingMode: snapshot.routingMode,
    throttleTier: snapshot.throttleTier,
    unhealthyComponents,
    totalPendingRows: snapshot.reservoir.totalPendingRows,
    oldestPendingAgeMs: snapshot.reservoir.oldestPendingAgeMs,
    retryWaitingRows: snapshot.reservoir.retryWaitingRows,
    earliestRetryAt: snapshot.reservoir.earliestRetryAt,
    replayState: snapshot.replay.state,
    replayQueuedEventCount: snapshot.replay.queuedEventCount,
    replayDeliveredEventCount: snapshot.replay.deliveredEventCount,
    replayNextRetryAt: snapshot.replay.nextRetryAt,
    replayConsecutiveFailureCount: snapshot.replay.consecutiveFailureCount,
    replayRetryBackoffActive,
  };
}

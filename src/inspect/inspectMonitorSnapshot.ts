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

  return {
    generatedAt: snapshot.generatedAt,
    routingMode: snapshot.routingMode,
    throttleTier: snapshot.throttleTier,
    unhealthyComponents,
    totalPendingRows: snapshot.reservoir.totalPendingRows,
    oldestPendingAgeMs: snapshot.reservoir.oldestPendingAgeMs,
    replayState: snapshot.replay.state,
    replayQueuedEventCount: snapshot.replay.queuedEventCount,
    replayDeliveredEventCount: snapshot.replay.deliveredEventCount,
  };
}

import type {
  MonitorComponent,
  MonitorDeliveryMode,
  MonitorHealthState,
  MonitorReplaySessionState,
  MonitorReplayTargetPath,
  MonitorRoutingMode,
  MonitorSourcePath,
  MonitorThrottleTier,
} from "./events.js";

export interface MonitorComponentHealthSnapshot {
  component: MonitorComponent;
  state: MonitorHealthState;
  observedAt: bigint;
  lastChangedAt: bigint;
  reasonCode: string | null;
  details: Record<string, unknown>;
}

export interface ReservoirStats {
  totalPendingRows: number;
  oldestPendingAgeMs: bigint;
  retryWaitingRows: number;
  earliestRetryAt: bigint | null;
  pendingRowsBySourcePath: Record<MonitorSourcePath, number>;
  pendingRowsByDeliveryMode: Partial<Record<MonitorDeliveryMode, number>>;
}

export interface ReplaySessionSnapshot {
  state: MonitorReplaySessionState;
  targetPath: MonitorReplayTargetPath;
  queuedEventCount: number;
  deliveredEventCount: number;
  startedAt: bigint | null;
  endedAt: bigint | null;
  lastError: string | null;
  nextRetryAt: bigint | null;
  consecutiveFailureCount: number;
  recoveryHeartbeatCount: number;
  requiredRecoveryHeartbeats: number;
}

export interface MonitorSnapshot {
  generatedAt: bigint;
  routingMode: MonitorRoutingMode;
  throttleTier: MonitorThrottleTier;
  components: Record<MonitorComponent, MonitorComponentHealthSnapshot>;
  reservoir: ReservoirStats;
  replay: ReplaySessionSnapshot;
}

export type MonitorOperationalState =
  | "healthy_live"
  | "degraded_live"
  | "buffering_only"
  | "replay_draining"
  | "replay_retry_waiting"
  | "recovery_confirming";

export interface InspectedMonitorSnapshot {
  generatedAt: bigint;
  operationalState: MonitorOperationalState;
  routingMode: MonitorRoutingMode;
  throttleTier: MonitorThrottleTier;
  unhealthyComponents: MonitorComponent[];
  requiresOperatorAttention: boolean;
  liveFlowGateClosed: boolean;
  liveFlowGateReason: string | null;
  totalPendingRows: number;
  oldestPendingAgeMs: bigint;
  replayReadyRows: number;
  retryWaitingRows: number;
  earliestRetryAt: bigint | null;
  replayState: MonitorReplaySessionState;
  replayBacklogRemainingRows: number;
  replayProgressPercent: number | null;
  replayQueuedEventCount: number;
  replayDeliveredEventCount: number;
  replayNextRetryAt: bigint | null;
  replayRetryDelayMs: bigint | null;
  replayConsecutiveFailureCount: number;
  replayRetryBackoffActive: boolean;
}

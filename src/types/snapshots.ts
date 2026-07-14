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

/** Stable schema identifier for the first JSON-safe operator snapshot. */
export type MonitorOperatorSnapshotSchema =
  "causal-order-monitor/operator-snapshot";

export type MonitorOperatorComponent =
  | MonitorComponent
  | "reservoir"
  | "replay";

export type MonitorOperatorStatus =
  | "healthy"
  | "degraded"
  | "buffering"
  | "recovering"
  | "attention_required"
  | "protective_refusal";

export type MonitorRecommendedAction =
  | "none"
  | "restore_affected_components"
  | "wait_for_retry"
  | "monitor_replay"
  | "inspect_replay_failure"
  | "relieve_protective_pressure"
  | "free_local_storage"
  | "stop_and_inspect_storage";

export type MonitorAdmissionPosture =
  | "accepted_live"
  | "accepted_buffered"
  | "protective_refusal";

export type MonitorAdmissionReasonCode =
  | "MONITOR_LIVE_FLOW_AVAILABLE"
  | "MONITOR_OUTAGE_BUFFERING"
  | "MONITOR_RECOVERY_GATE_BUFFERING"
  | "MONITOR_PROTECTIVE_THROTTLE";

export interface MonitorAdmissionSnapshotV1 {
  posture: MonitorAdmissionPosture;
  accepted: boolean;
  httpStatus: 202 | 503;
  reasonCode: MonitorAdmissionReasonCode;
}

export type MonitorStoragePressure =
  | "normal"
  | "elevated"
  | "critical"
  | "unknown";

/** Decimal strings are used for byte and millisecond values to remain JSON-safe. */
export interface MonitorStorageSnapshotV1 {
  pressure: MonitorStoragePressure;
  databaseBytes: string | null;
  walBytes: string | null;
  filesystemAvailableBytes: string | null;
  filesystemTotalBytes: string | null;
  filesystemUsedPercent: number | null;
}

export interface MonitorOperatorSnapshotV1 {
  schema: MonitorOperatorSnapshotSchema;
  version: 1;
  generatedAtMs: string;
  status: MonitorOperatorStatus;
  affectedComponents: MonitorOperatorComponent[];
  recommendedAction: MonitorRecommendedAction;
  routingMode: MonitorRoutingMode;
  throttleTier: MonitorThrottleTier;
  admission: MonitorAdmissionSnapshotV1;
  backlog: {
    totalRows: number;
    readyRows: number;
    retryWaitingRows: number;
    oldestAgeMs: string;
    earliestRetryAtMs: string | null;
  };
  replay: {
    state: MonitorReplaySessionState;
    gateClosed: boolean;
    backlogRemainingRows: number;
    queuedEventCount: number;
    deliveredEventCount: number;
    progressPercent: number | null;
    consecutiveFailureCount: number;
    nextRetryAtMs: string | null;
    retryDelayMs: string | null;
  };
  storage: MonitorStorageSnapshotV1;
}

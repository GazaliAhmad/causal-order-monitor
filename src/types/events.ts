export type MonitorComponent = "transport" | "dedupe" | "causal-order";

export type MonitorHealthState = "online" | "degraded" | "offline";

export type MonitorRoutingMode =
  | "normal"
  | "dedupe_bypass_throttled"
  | "order_buffer_only"
  | "full_outage_buffer"
  | "replay_through_dedupe";

export type MonitorThrottleTier = "open" | "slow" | "very_slow" | "paused";

export type MonitorSourcePath =
  | "transport_normalized_stream"
  | "deduped_observation";

export type MonitorDeliveryMode =
  | "normal"
  | "dedupe_bypass"
  | "order_buffer_only"
  | "full_outage_buffer"
  | "replay_through_dedupe";

export type MonitorReplaySessionState =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type MonitorReplayTargetPath = "dedupe_then_order";

export type MonitorPeerState = "connected" | "disconnected" | "degraded";

export type MonitorIngressAction = "accept" | "buffer_only" | "pause";

export interface MonitorClock extends Record<string, unknown> {
  physicalTimeMs: bigint;
}

export interface MonitorEventPayload {
  traceId?: string | null;
  entityId?: string | null;
  service?: string;
  operation?: string;
  [key: string]: unknown;
}

export interface MonitorIngressEvent {
  id: string;
  nodeId: string;
  clock: MonitorClock;
  payload: MonitorEventPayload;
  sequence?: bigint;
  traceId?: string | null;
  ingestedAt?: bigint;
  [key: string]: unknown;
}

export interface MonitorPeerStateEvent {
  peerId: string;
  state: MonitorPeerState;
  observedAt: bigint;
  details?: Record<string, unknown>;
}

export interface MonitorHealthUpdate {
  state: MonitorHealthState;
  observedAt?: bigint;
  reasonCode?: string | null;
  details?: Record<string, unknown>;
}

export interface MonitorIngressDecision {
  action: MonitorIngressAction;
  routingMode: MonitorRoutingMode;
  deliveryMode: MonitorDeliveryMode;
  throttleTier: MonitorThrottleTier;
  targetEventsPerSecond: number;
  targetBatchSize: number;
  reason: string;
}

import type {
  MonitorCapacityAdmissionPosture,
  MonitorCapacityLimitingDimension,
  MonitorCapacityReasonCode,
  MonitorStoragePressure,
} from "./snapshots.js";
import type {
  MonitorComponent,
  MonitorDeliveryMode,
  MonitorHealthState,
  MonitorReplaySessionState,
} from "./events.js";

export const MONITOR_LIFECYCLE_EVENT_NAMES = Object.freeze([
  "ingressAttempted",
  "ingressAccepted",
  "ingressRefused",
  "storageAppendFailed",
  "storageCheckpointCompleted",
  "deliveryAttempted",
  "deliveryHandlerCompleted",
  "deliveryAcknowledged",
  "deliveryFailed",
  "deliveryIndeterminate",
  "replayStateChanged",
  "replayBatchClaimed",
  "replayBatchAcknowledged",
  "replayBatchFailed",
  "retentionDeadLettered",
  "retentionDeleted",
  "healthChanged",
  "storagePressureObserved",
  "capacityPressureChanged",
  "operationDurationObserved",
] as const);

export type MonitorLifecycleEventName =
  (typeof MONITOR_LIFECYCLE_EVENT_NAMES)[number];

export interface MonitorLifecycleEventBase<T extends MonitorLifecycleEventName> {
  readonly type: T;
  /** JSON-safe unsigned decimal milliseconds from the monitor clock. */
  readonly occurredAtMs: string;
}

export interface MonitorLifecycleIngressAttemptedEvent extends MonitorLifecycleEventBase<"ingressAttempted"> {
  readonly eventId?: string;
  readonly sourceStreamId?: string | null;
}
export interface MonitorLifecycleIngressAcceptedEvent extends MonitorLifecycleEventBase<"ingressAccepted"> {
  readonly rowId: number;
  readonly eventId?: string;
  readonly deliveryMode?: MonitorDeliveryMode;
}
export interface MonitorLifecycleIngressRefusedEvent extends MonitorLifecycleEventBase<"ingressRefused"> {
  readonly reasonCode: string;
  readonly limitingDimension?: MonitorCapacityLimitingDimension;
}
export interface MonitorLifecycleStorageAppendFailedEvent extends MonitorLifecycleEventBase<"storageAppendFailed"> {
  readonly reasonCode: string;
  readonly eventId?: string;
}
export interface MonitorLifecycleStorageCheckpointCompletedEvent extends MonitorLifecycleEventBase<"storageCheckpointCompleted"> {
  readonly mode: string;
  readonly busy: boolean;
}
export interface MonitorLifecycleDeliveryEventBase<T extends "deliveryAttempted" | "deliveryHandlerCompleted" | "deliveryAcknowledged" | "deliveryFailed" | "deliveryIndeterminate"> extends MonitorLifecycleEventBase<T> {
  readonly rowId: number;
  readonly eventId?: string;
  readonly deliveryMode?: MonitorDeliveryMode;
  readonly replay?: boolean;
  readonly attempt?: number;
  readonly durationMs?: string;
}
export interface MonitorLifecycleDeliveryAttemptedEvent extends MonitorLifecycleDeliveryEventBase<"deliveryAttempted"> {}
export interface MonitorLifecycleDeliveryHandlerCompletedEvent extends MonitorLifecycleDeliveryEventBase<"deliveryHandlerCompleted"> {}
export interface MonitorLifecycleDeliveryAcknowledgedEvent extends MonitorLifecycleDeliveryEventBase<"deliveryAcknowledged"> {}
export interface MonitorLifecycleDeliveryFailedEvent extends MonitorLifecycleDeliveryEventBase<"deliveryFailed"> { readonly reasonCode: string; }
export interface MonitorLifecycleDeliveryIndeterminateEvent extends MonitorLifecycleDeliveryEventBase<"deliveryIndeterminate"> { readonly reasonCode: string; }
export interface MonitorLifecycleReplayStateChangedEvent extends MonitorLifecycleEventBase<"replayStateChanged"> {
  readonly previousState: MonitorReplaySessionState;
  readonly state: MonitorReplaySessionState;
  readonly queuedEventCount?: number;
  readonly deliveredEventCount?: number;
  readonly nextRetryAtMs?: string | null;
}
export interface MonitorLifecycleReplayBatchEventBase<T extends "replayBatchClaimed" | "replayBatchAcknowledged" | "replayBatchFailed"> extends MonitorLifecycleEventBase<T> {
  readonly rowIds: ReadonlyArray<number>;
  readonly count: number;
}
export interface MonitorLifecycleReplayBatchClaimedEvent extends MonitorLifecycleReplayBatchEventBase<"replayBatchClaimed"> {}
export interface MonitorLifecycleReplayBatchAcknowledgedEvent extends MonitorLifecycleReplayBatchEventBase<"replayBatchAcknowledged"> {}
export interface MonitorLifecycleReplayBatchFailedEvent extends MonitorLifecycleReplayBatchEventBase<"replayBatchFailed"> { readonly reasonCode: string; }
export interface MonitorLifecycleRetentionEventBase<T extends "retentionDeadLettered" | "retentionDeleted"> extends MonitorLifecycleEventBase<T> { readonly rowIds?: ReadonlyArray<number>; readonly count: number; }
export interface MonitorLifecycleRetentionDeadLetteredEvent extends MonitorLifecycleRetentionEventBase<"retentionDeadLettered"> {}
export interface MonitorLifecycleRetentionDeletedEvent extends MonitorLifecycleRetentionEventBase<"retentionDeleted"> {}
export interface MonitorLifecycleHealthChangedEvent extends MonitorLifecycleEventBase<"healthChanged"> {
  readonly component: MonitorComponent;
  readonly previousState: MonitorHealthState;
  readonly state: MonitorHealthState;
}
export interface MonitorLifecycleStoragePressureObservedEvent extends MonitorLifecycleEventBase<"storagePressureObserved"> {
  readonly pressure: MonitorStoragePressure;
  readonly databaseBytes?: string | null;
  readonly walBytes?: string | null;
  readonly filesystemAvailableBytes?: string | null;
}
export interface MonitorLifecycleCapacityPressureChangedEvent extends MonitorLifecycleEventBase<"capacityPressureChanged"> {
  readonly previousPosture: MonitorCapacityAdmissionPosture;
  readonly posture: MonitorCapacityAdmissionPosture;
  readonly reasonCode: MonitorCapacityReasonCode | null;
}
export interface MonitorLifecycleOperationDurationObservedEvent extends MonitorLifecycleEventBase<"operationDurationObserved"> { readonly operation: string; readonly durationMs: string; readonly outcome: string; }

export interface MonitorLifecycleEvents {
  ingressAttempted: MonitorLifecycleIngressAttemptedEvent;
  ingressAccepted: MonitorLifecycleIngressAcceptedEvent;
  ingressRefused: MonitorLifecycleIngressRefusedEvent;
  storageAppendFailed: MonitorLifecycleStorageAppendFailedEvent;
  storageCheckpointCompleted: MonitorLifecycleStorageCheckpointCompletedEvent;
  deliveryAttempted: MonitorLifecycleDeliveryAttemptedEvent;
  deliveryHandlerCompleted: MonitorLifecycleDeliveryHandlerCompletedEvent;
  deliveryAcknowledged: MonitorLifecycleDeliveryAcknowledgedEvent;
  deliveryFailed: MonitorLifecycleDeliveryFailedEvent;
  deliveryIndeterminate: MonitorLifecycleDeliveryIndeterminateEvent;
  replayStateChanged: MonitorLifecycleReplayStateChangedEvent;
  replayBatchClaimed: MonitorLifecycleReplayBatchClaimedEvent;
  replayBatchAcknowledged: MonitorLifecycleReplayBatchAcknowledgedEvent;
  replayBatchFailed: MonitorLifecycleReplayBatchFailedEvent;
  retentionDeadLettered: MonitorLifecycleRetentionDeadLetteredEvent;
  retentionDeleted: MonitorLifecycleRetentionDeletedEvent;
  healthChanged: MonitorLifecycleHealthChangedEvent;
  storagePressureObserved: MonitorLifecycleStoragePressureObservedEvent;
  capacityPressureChanged: MonitorLifecycleCapacityPressureChangedEvent;
  operationDurationObserved: MonitorLifecycleOperationDurationObservedEvent;
}

export type MonitorLifecycleEvent = MonitorLifecycleEvents[MonitorLifecycleEventName];
export type MonitorLifecycleListener<K extends MonitorLifecycleEventName> =
  (event: Readonly<MonitorLifecycleEvents[K]>) => void | Promise<void>;
export type MonitorLifecyclePublisher = <K extends MonitorLifecycleEventName>(
  event: MonitorLifecycleEvents[K],
) => void;

export interface MonitorLifecycleLastDropV1 {
  readonly occurredAtMs: string;
  readonly eventType: MonitorLifecycleEventName;
  readonly reason: "queue_overflow" | "shutdown";
}

export interface MonitorLifecycleSnapshotV1 {
  readonly schema: "causal-order-monitor/lifecycle-snapshot";
  readonly version: 1;
  readonly generatedAtMs: string;
  readonly status: "open" | "closed";
  readonly queueDepth: number;
  readonly queueCapacity: number;
  readonly overflowPolicy: "drop_oldest";
  readonly subscriberCount: number;
  readonly droppedTotal: number;
  readonly listenerFailureTotal: number;
  readonly lastDrop: MonitorLifecycleLastDropV1 | null;
}

export interface MonitorLifecycleFlushResult {
  readonly status: "drained" | "timed_out" | "closed";
  readonly queueDepth: number;
  readonly activeDispatch: boolean;
}

export interface MonitorLifecycleFacet {
  subscribe<K extends MonitorLifecycleEventName>(
    eventName: K,
    listener: MonitorLifecycleListener<K>,
  ): () => void;
  flush(timeoutMs?: bigint): Promise<MonitorLifecycleFlushResult>;
  getSnapshot(): MonitorLifecycleSnapshotV1;
}

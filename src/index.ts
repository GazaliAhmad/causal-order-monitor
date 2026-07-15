export const monitorPackageVersion = "0.3.1";

export type MonitorImplementationStatus = "replay_operational";

export const monitorImplementationStatus: MonitorImplementationStatus =
  "replay_operational";

import { HealthTracker as HealthTrackerImpl } from "./health/HealthTracker.js";
import {
  ReplayCoordinator as ReplayCoordinatorImpl,
  type ReplayBatch as ReplayBatchType,
} from "./replay/ReplayCoordinator.js";
import { DeliveryRouter as DeliveryRouterImpl } from "./routing/DeliveryRouter.js";
import { ThrottleController as ThrottleControllerImpl } from "./throttle/ThrottleController.js";

export {
  createDefaultMonitorNow,
  createDefaultMonitorConfig,
  type MonitorComponentHealthConfig,
  type MonitorConfig,
  type MonitorHealthConfig,
  type MonitorJsonComponentHealthConfig,
  type MonitorJsonConfig,
  type MonitorJsonDuration,
  type MonitorJsonHealthConfig,
  type MonitorJsonReplayConfig,
  type MonitorJsonReservoirConfig,
  type MonitorJsonThrottleConfig,
  type MonitorJsonThrottleTierConfig,
  type MonitorJsonTransportConfig,
  type MonitorReplayConfig,
  type MonitorReservoirConfig,
  type MonitorThrottleConfig,
  type MonitorThrottleTierConfig,
  type MonitorTransportConfig,
} from "./types/config.js";
export {
  DEFAULT_MONITOR_CONFIG_FILE,
  MONITOR_CONFIG_ENV_VAR,
  loadMonitorConfigFromEnvironment,
  loadMonitorConfigFile,
  parseMonitorConfigJson,
  type MonitorConfigOverride,
  resolveMonitorConfigFromEnvironment,
  resolveMonitorConfig,
  type MonitorConfigEnvironmentOptions,
} from "./config.js";
export {
  type MonitorClock,
  type MonitorComponent,
  type MonitorDeliveryMode,
  type MonitorEventTimingEvidence,
  type MonitorHealthState,
  type MonitorHealthUpdate,
  type MonitorIngressAction,
  type MonitorIngressDecision,
  type MonitorIngressEvent,
  type MonitorPeerState,
  type MonitorPeerStateEvent,
  type MonitorReplaySessionState,
  type MonitorReplayTargetPath,
  type MonitorRoutingMode,
  type MonitorSourcePath,
  type MonitorThrottleTier,
} from "./types/events.js";
export {
  type MonitorOperationalState,
  type InspectedMonitorSnapshot,
  type MonitorComponentHealthSnapshot,
  type MonitorSnapshot,
  type ReplaySessionSnapshot,
  type ReservoirStats,
  type MonitorAdmissionSnapshotV1,
  type MonitorOperatorComponent,
  type MonitorOperatorSnapshotSchema,
  type MonitorOperatorSnapshotV1,
  type MonitorOperatorStatus,
  type MonitorRecommendedAction,
  type MonitorStoragePressure,
  type MonitorStorageSnapshotV1,
} from "./types/snapshots.js";
export {
  inspectMonitorSnapshot,
  inspectMonitorSnapshotV1,
} from "./inspect/inspectMonitorSnapshot.js";
export {
  classifyMonitorBoundaryFailure,
  deriveMonitorAdmissionDecision,
  MonitorAdmissionRefusedError,
  MonitorBoundaryError,
  MonitorClosedError,
  MonitorIndeterminateOutcomeError,
  type MonitorAdmissionDecision,
  type MonitorBoundaryErrorCode,
  type MonitorBoundaryFailure,
  type MonitorBoundaryOutcome,
  type MonitorBoundaryRecommendedAction,
} from "./boundary.js";
export {
  createMonitorRuntime,
  createMonitorRuntimeFromEnvironment,
  createMonitorRuntimeFromFile,
} from "./runtime/createMonitorRuntime.js";
export { MonitorRuntime, ReplayOwnershipError } from "./runtime/MonitorRuntime.js";
export {
  SQLiteReservoir,
  type PruneResult,
  type ReservoirLifecycleStats,
  type ReservoirReplayEntry,
  type WalCheckpointMode,
  type WalCheckpointResult,
} from "./storage/SQLiteReservoir.js";
export {
  createTransportMonitorAdapterFromEnvironment,
  createTransportMonitorAdapterFromFile,
  TransportMonitorAdapter,
  type MonitorAdapterForwardContext,
  type MonitorAdapterHandlers,
  type MonitorIngestResult,
  type ReplayPumpResult,
} from "./transport/TransportMonitorAdapter.js";
export {
  monitorHarnessArtifacts,
  monitorHarnessScenarios,
  type MonitorHarnessAdapterContract,
  type MonitorHarnessArtifactSpec,
  type MonitorHarnessExpectation,
  type MonitorHarnessRuntimeKind,
  type MonitorHarnessScenarioDefinition,
  type MonitorHarnessScenarioId,
} from "./testing/monitorHarness.js";

/** @deprecated Import `HealthTracker` from `@causal-order/monitor/health` instead. */
export const HealthTracker = HealthTrackerImpl;

/** @deprecated Import `ReplayCoordinator` from `@causal-order/monitor/replay` instead. */
export const ReplayCoordinator = ReplayCoordinatorImpl;

/** @deprecated Import `ReplayBatch` from `@causal-order/monitor/replay` instead. */
export type ReplayBatch = ReplayBatchType;

/** @deprecated Import `DeliveryRouter` from `@causal-order/monitor/routing` instead. */
export const DeliveryRouter = DeliveryRouterImpl;

/** @deprecated Import `ThrottleController` from `@causal-order/monitor/throttle` instead. */
export const ThrottleController = ThrottleControllerImpl;

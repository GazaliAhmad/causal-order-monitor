export const monitorPackageVersion = "0.0.9";

export type MonitorImplementationStatus = "replay_operational";

export const monitorImplementationStatus: MonitorImplementationStatus =
  "replay_operational";

export {
  createDefaultMonitorConfig,
  type MonitorComponentHealthConfig,
  type MonitorConfig,
  type MonitorHealthConfig,
  type MonitorReplayConfig,
  type MonitorReservoirConfig,
  type MonitorThrottleConfig,
  type MonitorThrottleTierConfig,
  type MonitorTransportConfig,
} from "./types/config.js";
export {
  type MonitorClock,
  type MonitorComponent,
  type MonitorDeliveryMode,
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
  type InspectedMonitorSnapshot,
  type MonitorComponentHealthSnapshot,
  type MonitorSnapshot,
  type ReplaySessionSnapshot,
  type ReservoirStats,
} from "./types/snapshots.js";
export { inspectMonitorSnapshot } from "./inspect/inspectMonitorSnapshot.js";
export { HealthTracker } from "./health/HealthTracker.js";
export { ReplayCoordinator, type ReplayBatch } from "./replay/ReplayCoordinator.js";
export { DeliveryRouter } from "./routing/DeliveryRouter.js";
export { createMonitorRuntime } from "./runtime/createMonitorRuntime.js";
export { MonitorRuntime } from "./runtime/MonitorRuntime.js";
export {
  SQLiteReservoir,
  type ReservoirReplayEntry,
} from "./storage/SQLiteReservoir.js";
export {
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
export { ThrottleController } from "./throttle/ThrottleController.js";

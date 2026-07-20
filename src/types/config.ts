import { resolve } from "node:path";

import type { MonitorThrottleTier } from "./events.js";

export const DEFAULT_MONITOR_CONFIG_FILE = "monitor.config.json";

const DEFAULT_MONITOR_DB_PATH = resolve(
  ".causal-order-monitor",
  "monitor.sqlite",
);

export interface MonitorReservoirConfig {
  databasePath: string;
  rollingBufferWindowMs: bigint;
  fullOutageMaxWindowMs: bigint;
  pruneIntervalMs: bigint;
  pruneBatchSize: number;
  deliveredRetentionMs?: bigint;
  deadLetterRetentionMs?: bigint;
  walAutoCheckpointPages?: number;
  capacity?: MonitorCapacityConfig;
}

export type MonitorCapacityOverflowPolicy = "reject_new";

export type MonitorFilesystemUnavailableEvidencePolicy =
  | "allow_logical_admission"
  | "refuse_admission";

export interface MonitorFilesystemReserveConfig {
  minimumAvailableBytes: bigint;
  resumeAvailableBytes: bigint;
  unavailableEvidence: MonitorFilesystemUnavailableEvidencePolicy;
}

export interface MonitorCapacityConfig {
  maxSerializedEventBytes: bigint | null;
  maxPendingRows: number | null;
  maxPendingSerializedBytes: bigint | null;
  filesystemReserve: MonitorFilesystemReserveConfig | null;
  overflowPolicy: MonitorCapacityOverflowPolicy;
}

export interface MonitorTransportConfig {
  heartbeatGraceMs: bigint;
  reconnectBurstWindowMs: bigint;
  sourceLabel?: string;
}

export interface MonitorComponentHealthConfig {
  degradedAfterMs: bigint;
  offlineAfterMs: bigint;
}

export interface MonitorHealthConfig {
  transport: MonitorComponentHealthConfig;
  dedupe: MonitorComponentHealthConfig;
  causalOrder: MonitorComponentHealthConfig;
}

export interface MonitorThrottleTierConfig {
  maxEventsPerSecond: number;
  batchSize: number;
}

export interface MonitorThrottleConfig {
  open: MonitorThrottleTierConfig;
  slow: MonitorThrottleTierConfig;
  verySlow: MonitorThrottleTierConfig;
  paused: MonitorThrottleTierConfig;
  defaultTier: MonitorThrottleTier;
}

export interface MonitorReplayConfig {
  healthConfirmationHeartbeats: number;
  pauseLiveFlowDuringReplay: boolean;
  retryBackoffMs: bigint;
}

export type MonitorStartupHealthPolicy = "optimistic" | "conservative";

export interface MonitorStartupConfig {
  healthPolicy: MonitorStartupHealthPolicy;
}

export type MonitorLifecycleOverflowPolicy = "drop_oldest";

export interface MonitorLifecycleConfig {
  queueCapacity: number;
  overflowPolicy: MonitorLifecycleOverflowPolicy;
  shutdownFlushTimeoutMs: bigint;
}

export interface MonitorConfig {
  reservoir: MonitorReservoirConfig;
  transport: MonitorTransportConfig;
  health: MonitorHealthConfig;
  throttle: MonitorThrottleConfig;
  replay: MonitorReplayConfig;
  startup: MonitorStartupConfig;
  lifecycle: MonitorLifecycleConfig;
  now?: () => bigint;
}

export function createDefaultMonitorNow(): () => bigint {
  const wallClockBaseMs = BigInt(Date.now());
  const monotonicBaseNs = process.hrtime.bigint();
  let lastEmittedMs = wallClockBaseMs;

  return () => {
    const monotonicElapsedMs =
      (process.hrtime.bigint() - monotonicBaseNs) / 1_000_000n;
    const candidateMs = wallClockBaseMs + monotonicElapsedMs;
    if (candidateMs < lastEmittedMs) {
      return lastEmittedMs;
    }
    lastEmittedMs = candidateMs;
    return candidateMs;
  };
}

export type MonitorJsonDuration = number | string;

export interface MonitorJsonReservoirConfig {
  databasePath?: string;
  rollingBufferWindowMs?: MonitorJsonDuration;
  fullOutageMaxWindowMs?: MonitorJsonDuration;
  pruneIntervalMs?: MonitorJsonDuration;
  pruneBatchSize?: number;
  deliveredRetentionMs?: MonitorJsonDuration;
  deadLetterRetentionMs?: MonitorJsonDuration;
  walAutoCheckpointPages?: number;
  capacity?: MonitorJsonCapacityConfig;
}

export type MonitorJsonByteLimit = number | string | null;

export interface MonitorJsonCapacityConfig {
  maxSerializedEventBytes?: MonitorJsonByteLimit;
  maxPendingRows?: number | null;
  maxPendingSerializedBytes?: MonitorJsonByteLimit;
  filesystemReserve?: MonitorJsonFilesystemReserveConfig | null;
  overflowPolicy?: MonitorCapacityOverflowPolicy;
}

export interface MonitorJsonFilesystemReserveConfig {
  minimumAvailableBytes: MonitorJsonByteLimit;
  resumeAvailableBytes: MonitorJsonByteLimit;
  unavailableEvidence: MonitorFilesystemUnavailableEvidencePolicy;
}

export interface MonitorJsonTransportConfig {
  heartbeatGraceMs?: MonitorJsonDuration;
  reconnectBurstWindowMs?: MonitorJsonDuration;
  sourceLabel?: string;
}

export interface MonitorJsonComponentHealthConfig {
  degradedAfterMs?: MonitorJsonDuration;
  offlineAfterMs?: MonitorJsonDuration;
}

export interface MonitorJsonHealthConfig {
  transport?: MonitorJsonComponentHealthConfig;
  dedupe?: MonitorJsonComponentHealthConfig;
  causalOrder?: MonitorJsonComponentHealthConfig;
}

export interface MonitorJsonThrottleTierConfig {
  maxEventsPerSecond?: number;
  batchSize?: number;
}

export interface MonitorJsonThrottleConfig {
  open?: MonitorJsonThrottleTierConfig;
  slow?: MonitorJsonThrottleTierConfig;
  verySlow?: MonitorJsonThrottleTierConfig;
  paused?: MonitorJsonThrottleTierConfig;
  defaultTier?: MonitorThrottleTier;
}

export interface MonitorJsonReplayConfig {
  healthConfirmationHeartbeats?: number;
  pauseLiveFlowDuringReplay?: boolean;
  retryBackoffMs?: MonitorJsonDuration;
}

export interface MonitorJsonStartupConfig {
  healthPolicy?: MonitorStartupHealthPolicy;
}

export interface MonitorJsonLifecycleConfig {
  queueCapacity?: number;
  overflowPolicy?: MonitorLifecycleOverflowPolicy;
  shutdownFlushTimeoutMs?: MonitorJsonDuration;
}

export interface MonitorJsonConfig {
  reservoir?: MonitorJsonReservoirConfig;
  transport?: MonitorJsonTransportConfig;
  health?: MonitorJsonHealthConfig;
  throttle?: MonitorJsonThrottleConfig;
  replay?: MonitorJsonReplayConfig;
  startup?: MonitorJsonStartupConfig;
  lifecycle?: MonitorJsonLifecycleConfig;
}

export function createDefaultMonitorConfig(): MonitorConfig {
  return {
    reservoir: {
      databasePath: DEFAULT_MONITOR_DB_PATH,
      rollingBufferWindowMs: 4n * 60n * 60n * 1000n,
      fullOutageMaxWindowMs: 6n * 60n * 60n * 1000n,
      pruneIntervalMs: 60_000n,
      pruneBatchSize: 1_000,
      deliveredRetentionMs: 24n * 60n * 60n * 1000n,
      deadLetterRetentionMs: 7n * 24n * 60n * 60n * 1000n,
      walAutoCheckpointPages: 1_000,
      capacity: {
        maxSerializedEventBytes: null,
        maxPendingRows: null,
        maxPendingSerializedBytes: null,
        filesystemReserve: null,
        overflowPolicy: "reject_new",
      },
    },
    transport: {
      heartbeatGraceMs: 15_000n,
      reconnectBurstWindowMs: 30_000n,
      sourceLabel: "@causal-order/transport",
    },
    health: {
      transport: {
        degradedAfterMs: 10_000n,
        offlineAfterMs: 30_000n,
      },
      dedupe: {
        degradedAfterMs: 10_000n,
        offlineAfterMs: 30_000n,
      },
      causalOrder: {
        degradedAfterMs: 10_000n,
        offlineAfterMs: 30_000n,
      },
    },
    throttle: {
      open: {
        maxEventsPerSecond: 5_000,
        batchSize: 500,
      },
      slow: {
        maxEventsPerSecond: 1_000,
        batchSize: 200,
      },
      verySlow: {
        maxEventsPerSecond: 250,
        batchSize: 50,
      },
      paused: {
        maxEventsPerSecond: 0,
        batchSize: 0,
      },
      defaultTier: "open",
    },
    replay: {
      healthConfirmationHeartbeats: 2,
      pauseLiveFlowDuringReplay: true,
      retryBackoffMs: 5_000n,
    },
    startup: {
      healthPolicy: "optimistic",
    },
    lifecycle: {
      queueCapacity: 1_024,
      overflowPolicy: "drop_oldest",
      shutdownFlushTimeoutMs: 1_000n,
    },
    now: createDefaultMonitorNow(),
  };
}

import { resolve } from "node:path";

import type { MonitorThrottleTier } from "./events.js";

const DEFAULT_MONITOR_DB_PATH = resolve(
  ".causal-order-monitor",
  "monitor.sqlite",
);

export interface MonitorReservoirConfig {
  databasePath: string;
  rollingBufferWindowMs: bigint;
  fullOutageMaxWindowMs: bigint;
  pruneIntervalMs: bigint;
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

export interface MonitorConfig {
  reservoir: MonitorReservoirConfig;
  transport: MonitorTransportConfig;
  health: MonitorHealthConfig;
  throttle: MonitorThrottleConfig;
  replay: MonitorReplayConfig;
  now?: () => bigint;
}

export function createDefaultMonitorConfig(): MonitorConfig {
  return {
    reservoir: {
      databasePath: DEFAULT_MONITOR_DB_PATH,
      rollingBufferWindowMs: 4n * 60n * 60n * 1000n,
      fullOutageMaxWindowMs: 6n * 60n * 60n * 1000n,
      pruneIntervalMs: 60_000n,
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
    now: () => BigInt(Date.now()),
  };
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { MonitorThrottleTier } from "./types/events.js";
import {
  createDefaultMonitorNow,
  createDefaultMonitorConfig,
  DEFAULT_MONITOR_CONFIG_FILE,
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

const DURATION_PATTERN = /^(?<value>\d+)(?<unit>ms|s|m|h)$/;
export const MONITOR_CONFIG_ENV_VAR = "CAUSAL_ORDER_MONITOR_CONFIG";

const MONITOR_THROTTLE_TIERS: ReadonlyArray<MonitorThrottleTier> = [
  "open",
  "slow",
  "very_slow",
  "paused",
];

interface ParsedMonitorHealthConfig {
  transport?: Partial<MonitorComponentHealthConfig>;
  dedupe?: Partial<MonitorComponentHealthConfig>;
  causalOrder?: Partial<MonitorComponentHealthConfig>;
}

interface ParsedMonitorThrottleConfig {
  open?: Partial<MonitorThrottleTierConfig>;
  slow?: Partial<MonitorThrottleTierConfig>;
  verySlow?: Partial<MonitorThrottleTierConfig>;
  paused?: Partial<MonitorThrottleTierConfig>;
  defaultTier?: MonitorThrottleTier;
}

export interface MonitorConfigEnvironmentOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  defaultConfigFile?: string;
}

export interface MonitorConfigOverride {
  reservoir?: Partial<MonitorReservoirConfig>;
  transport?: Partial<MonitorTransportConfig>;
  health?: {
    transport?: Partial<MonitorComponentHealthConfig>;
    dedupe?: Partial<MonitorComponentHealthConfig>;
    causalOrder?: Partial<MonitorComponentHealthConfig>;
  };
  throttle?: {
    open?: Partial<MonitorThrottleTierConfig>;
    slow?: Partial<MonitorThrottleTierConfig>;
    verySlow?: Partial<MonitorThrottleTierConfig>;
    paused?: Partial<MonitorThrottleTierConfig>;
    defaultTier?: MonitorThrottleTier;
  };
  replay?: Partial<MonitorReplayConfig>;
  now?: () => bigint;
}

function formatPath(pathSegments: ReadonlyArray<string>): string {
  return pathSegments.join(".");
}

function assertObject(
  value: unknown,
  pathSegments: ReadonlyArray<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${formatPath(pathSegments)} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlyArray<string>,
  pathSegments: ReadonlyArray<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(
        `${formatPath([...pathSegments, key])} is not a supported monitor config key.`,
      );
    }
  }
}

function parseDurationMs(
  value: MonitorJsonDuration,
  pathSegments: ReadonlyArray<string>,
): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `${formatPath(pathSegments)} must be a non-negative integer duration in milliseconds.`,
      );
    }
    return BigInt(value);
  }

  const normalized = value.trim();
  const match = DURATION_PATTERN.exec(normalized);
  if (!match?.groups) {
    throw new Error(
      `${formatPath(pathSegments)} must be an integer millisecond value or duration string like 15000ms, 30s, 5m, or 4h.`,
    );
  }

  const durationValue = BigInt(match.groups.value);
  switch (match.groups.unit) {
    case "ms":
      return durationValue;
    case "s":
      return durationValue * 1000n;
    case "m":
      return durationValue * 60_000n;
    case "h":
      return durationValue * 3_600_000n;
    default:
      throw new Error(`${formatPath(pathSegments)} uses an unsupported duration unit.`);
  }
}

function parseOptionalString(
  value: unknown,
  pathSegments: ReadonlyArray<string>,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${formatPath(pathSegments)} must be a string.`);
  }
  return value;
}

function parseOptionalBoolean(
  value: unknown,
  pathSegments: ReadonlyArray<string>,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${formatPath(pathSegments)} must be a boolean.`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  pathSegments: ReadonlyArray<string>,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${formatPath(pathSegments)} must be a non-negative integer.`);
  }
  return value as number;
}

function parseOptionalPositiveInteger(
  value: unknown,
  pathSegments: ReadonlyArray<string>,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${formatPath(pathSegments)} must be a positive integer.`);
  }
  return value as number;
}

function parseOptionalDuration(
  value: unknown,
  pathSegments: ReadonlyArray<string>,
): bigint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${formatPath(pathSegments)} must be a duration string or integer milliseconds.`);
  }
  return parseDurationMs(value, pathSegments);
}

function parseReservoirConfig(
  value: MonitorJsonReservoirConfig | undefined,
): Partial<MonitorReservoirConfig> {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["reservoir"]);
  assertAllowedKeys(
    objectValue,
    [
      "databasePath",
      "rollingBufferWindowMs",
      "fullOutageMaxWindowMs",
      "pruneIntervalMs",
      "pruneBatchSize",
    ],
    ["reservoir"],
  );

  return {
    databasePath: parseOptionalString(objectValue.databasePath, ["reservoir", "databasePath"]),
    rollingBufferWindowMs: parseOptionalDuration(
      objectValue.rollingBufferWindowMs,
      ["reservoir", "rollingBufferWindowMs"],
    ),
    fullOutageMaxWindowMs: parseOptionalDuration(
      objectValue.fullOutageMaxWindowMs,
      ["reservoir", "fullOutageMaxWindowMs"],
    ),
    pruneIntervalMs: parseOptionalDuration(
      objectValue.pruneIntervalMs,
      ["reservoir", "pruneIntervalMs"],
    ),
    pruneBatchSize: parseOptionalPositiveInteger(
      objectValue.pruneBatchSize,
      ["reservoir", "pruneBatchSize"],
    ),
  };
}

function parseTransportConfig(
  value: MonitorJsonTransportConfig | undefined,
): Partial<MonitorTransportConfig> {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["transport"]);
  assertAllowedKeys(
    objectValue,
    ["heartbeatGraceMs", "reconnectBurstWindowMs", "sourceLabel"],
    ["transport"],
  );

  return {
    heartbeatGraceMs: parseOptionalDuration(
      objectValue.heartbeatGraceMs,
      ["transport", "heartbeatGraceMs"],
    ),
    reconnectBurstWindowMs: parseOptionalDuration(
      objectValue.reconnectBurstWindowMs,
      ["transport", "reconnectBurstWindowMs"],
    ),
    sourceLabel: parseOptionalString(objectValue.sourceLabel, ["transport", "sourceLabel"]),
  };
}

function parseComponentHealthConfig(
  value: MonitorJsonComponentHealthConfig | undefined,
  componentName: "transport" | "dedupe" | "causalOrder",
): Partial<MonitorComponentHealthConfig> {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["health", componentName]);
  assertAllowedKeys(objectValue, ["degradedAfterMs", "offlineAfterMs"], ["health", componentName]);

  return {
    degradedAfterMs: parseOptionalDuration(
      objectValue.degradedAfterMs,
      ["health", componentName, "degradedAfterMs"],
    ),
    offlineAfterMs: parseOptionalDuration(
      objectValue.offlineAfterMs,
      ["health", componentName, "offlineAfterMs"],
    ),
  };
}

function parseHealthConfig(
  value: MonitorJsonHealthConfig | undefined,
): ParsedMonitorHealthConfig {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["health"]);
  assertAllowedKeys(objectValue, ["transport", "dedupe", "causalOrder"], ["health"]);

  return {
    transport: parseComponentHealthConfig(
      objectValue.transport as MonitorJsonComponentHealthConfig | undefined,
      "transport",
    ),
    dedupe: parseComponentHealthConfig(
      objectValue.dedupe as MonitorJsonComponentHealthConfig | undefined,
      "dedupe",
    ),
    causalOrder: parseComponentHealthConfig(
      objectValue.causalOrder as MonitorJsonComponentHealthConfig | undefined,
      "causalOrder",
    ),
  };
}

function parseThrottleTierConfig(
  value: MonitorJsonThrottleTierConfig | undefined,
  tierName: MonitorThrottleTier,
): Partial<MonitorThrottleTierConfig> {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["throttle", tierName]);
  assertAllowedKeys(objectValue, ["maxEventsPerSecond", "batchSize"], ["throttle", tierName]);

  return {
    maxEventsPerSecond: parseOptionalNonNegativeInteger(
      objectValue.maxEventsPerSecond,
      ["throttle", tierName, "maxEventsPerSecond"],
    ),
    batchSize: parseOptionalNonNegativeInteger(
      objectValue.batchSize,
      ["throttle", tierName, "batchSize"],
    ),
  };
}

function parseThrottleDefaultTier(value: unknown): MonitorThrottleTier | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !MONITOR_THROTTLE_TIERS.includes(value as MonitorThrottleTier)
  ) {
    throw new Error("throttle.defaultTier must be one of open, slow, very_slow, or paused.");
  }
  return value as MonitorThrottleTier;
}

function parseThrottleConfig(
  value: MonitorJsonThrottleConfig | undefined,
): ParsedMonitorThrottleConfig {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["throttle"]);
  assertAllowedKeys(
    objectValue,
    ["open", "slow", "verySlow", "paused", "defaultTier"],
    ["throttle"],
  );

  return {
    open: parseThrottleTierConfig(
      objectValue.open as MonitorJsonThrottleTierConfig | undefined,
      "open",
    ),
    slow: parseThrottleTierConfig(
      objectValue.slow as MonitorJsonThrottleTierConfig | undefined,
      "slow",
    ),
    verySlow: parseThrottleTierConfig(
      objectValue.verySlow as MonitorJsonThrottleTierConfig | undefined,
      "very_slow",
    ),
    paused: parseThrottleTierConfig(
      objectValue.paused as MonitorJsonThrottleTierConfig | undefined,
      "paused",
    ),
    defaultTier: parseThrottleDefaultTier(objectValue.defaultTier),
  };
}

function parseReplayConfig(
  value: MonitorJsonReplayConfig | undefined,
): Partial<MonitorReplayConfig> {
  if (value === undefined) {
    return {};
  }

  const objectValue = assertObject(value, ["replay"]);
  assertAllowedKeys(
    objectValue,
    ["healthConfirmationHeartbeats", "pauseLiveFlowDuringReplay", "retryBackoffMs"],
    ["replay"],
  );

  return {
    healthConfirmationHeartbeats: parseOptionalNonNegativeInteger(
      objectValue.healthConfirmationHeartbeats,
      ["replay", "healthConfirmationHeartbeats"],
    ),
    pauseLiveFlowDuringReplay: parseOptionalBoolean(
      objectValue.pauseLiveFlowDuringReplay,
      ["replay", "pauseLiveFlowDuringReplay"],
    ),
    retryBackoffMs: parseOptionalDuration(
      objectValue.retryBackoffMs,
      ["replay", "retryBackoffMs"],
    ),
  };
}

export function parseMonitorConfigJson(jsonText: string): MonitorJsonConfig {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Monitor config JSON is invalid: ${message}`);
  }

  const objectValue = assertObject(parsedValue, ["monitorConfig"]);
  assertAllowedKeys(
    objectValue,
    ["reservoir", "transport", "health", "throttle", "replay"],
    ["monitorConfig"],
  );

  return objectValue as MonitorJsonConfig;
}

function resolvePartialMonitorConfig(
  config: MonitorJsonConfig = {},
): MonitorConfigOverride {
  const reservoir = parseReservoirConfig(config.reservoir);
  const transport = parseTransportConfig(config.transport);
  const health = parseHealthConfig(config.health);
  const throttle = parseThrottleConfig(config.throttle);
  const replay = parseReplayConfig(config.replay);

  return {
    reservoir: {
      ...reservoir,
    },
    transport: {
      ...transport,
    },
    health: {
      transport: health.transport,
      dedupe: health.dedupe,
      causalOrder: health.causalOrder,
    },
    throttle: {
      open: {
        ...throttle.open,
      },
      slow: {
        ...throttle.slow,
      },
      verySlow: {
        ...throttle.verySlow,
      },
      paused: {
        ...throttle.paused,
      },
      defaultTier: throttle.defaultTier,
    },
    replay: {
      ...replay,
    },
  };
}

function mergeMonitorConfig(
  base: MonitorConfig,
  override: MonitorConfigOverride,
): MonitorConfig {
  return {
    ...base,
    ...override,
    reservoir: {
      ...base.reservoir,
      ...override.reservoir,
    },
    transport: {
      ...base.transport,
      ...override.transport,
    },
    health: {
      transport: {
        ...base.health.transport,
        ...override.health?.transport,
      },
      dedupe: {
        ...base.health.dedupe,
        ...override.health?.dedupe,
      },
      causalOrder: {
        ...base.health.causalOrder,
        ...override.health?.causalOrder,
      },
    },
    throttle: {
      ...base.throttle,
      ...override.throttle,
      open: {
        ...base.throttle.open,
        ...override.throttle?.open,
      },
      slow: {
        ...base.throttle.slow,
        ...override.throttle?.slow,
      },
      verySlow: {
        ...base.throttle.verySlow,
        ...override.throttle?.verySlow,
      },
      paused: {
        ...base.throttle.paused,
        ...override.throttle?.paused,
      },
    },
    replay: {
      ...base.replay,
      ...override.replay,
    },
  };
}

function resolveConfigPath(configPath: string, cwd = process.cwd()): string {
  return resolve(cwd, configPath);
}

function loadPartialMonitorConfigFileAtPath(
  resolvedPath: string,
): MonitorConfigOverride {
  const jsonText = readFileSync(resolvedPath, "utf8");
  const parsedConfig = parseMonitorConfigJson(jsonText);
  return resolvePartialMonitorConfig(parsedConfig);
}

export function resolveMonitorConfig(
  config: MonitorJsonConfig = {},
): MonitorConfig {
  return mergeMonitorConfig(
    createDefaultMonitorConfig(),
    resolvePartialMonitorConfig(config),
  );
}

export function loadMonitorConfigFile(
  configPath = DEFAULT_MONITOR_CONFIG_FILE,
): MonitorConfig {
  const resolvedPath = resolveConfigPath(configPath);
  return mergeMonitorConfig(
    createDefaultMonitorConfig(),
    loadPartialMonitorConfigFileAtPath(resolvedPath),
  );
}

export function resolveMonitorConfigFromEnvironment(
  inlineConfig: MonitorConfigOverride = {},
  options: MonitorConfigEnvironmentOptions = {},
): MonitorConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const defaultConfigFile = options.defaultConfigFile ?? DEFAULT_MONITOR_CONFIG_FILE;
  const configuredPath = env[MONITOR_CONFIG_ENV_VAR];
  let fileConfig: MonitorConfigOverride = {};

  if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
    const resolvedPath = resolveConfigPath(configuredPath, cwd);
    try {
      fileConfig = loadPartialMonitorConfigFileAtPath(resolvedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load monitor config from ${MONITOR_CONFIG_ENV_VAR} at "${resolvedPath}": ${message}`,
      );
    }
  } else {
    const defaultResolvedPath = resolveConfigPath(defaultConfigFile, cwd);
    if (existsSync(defaultResolvedPath)) {
      fileConfig = loadPartialMonitorConfigFileAtPath(defaultResolvedPath);
    }
  }

  return mergeMonitorConfig(
    mergeMonitorConfig(createDefaultMonitorConfig(), fileConfig),
    inlineConfig,
  );
}

export function loadMonitorConfigFromEnvironment(
  options: MonitorConfigEnvironmentOptions = {},
): MonitorConfig {
  return resolveMonitorConfigFromEnvironment({}, options);
}

export {
  createDefaultMonitorNow,
  createDefaultMonitorConfig,
  DEFAULT_MONITOR_CONFIG_FILE,
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
};

import { MonitorRuntime } from "./MonitorRuntime.js";
import {
  loadMonitorConfigFile,
  resolveMonitorConfigFromEnvironment,
  type MonitorConfigEnvironmentOptions,
  type MonitorConfigOverride,
} from "../config.js";

export function createMonitorRuntime(
  config: MonitorConfigOverride = {},
): MonitorRuntime {
  return new MonitorRuntime(config);
}

export function createMonitorRuntimeFromFile(
  configPath?: string,
): MonitorRuntime {
  return new MonitorRuntime(loadMonitorConfigFile(configPath));
}

export function createMonitorRuntimeFromEnvironment(
  inlineConfig: MonitorConfigOverride = {},
  options: MonitorConfigEnvironmentOptions = {},
): MonitorRuntime {
  return new MonitorRuntime(
    resolveMonitorConfigFromEnvironment(inlineConfig, options),
  );
}

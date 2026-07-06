import { MonitorRuntime } from "./MonitorRuntime.js";
import type { MonitorConfig } from "../types/config.js";

export function createMonitorRuntime(
  config: Partial<MonitorConfig> = {},
): MonitorRuntime {
  return new MonitorRuntime(config);
}

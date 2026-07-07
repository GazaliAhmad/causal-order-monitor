import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MONITOR_CONFIG_FILE,
  MONITOR_CONFIG_ENV_VAR,
  createDefaultMonitorConfig,
  loadMonitorConfigFromEnvironment,
  resolveMonitorConfigFromEnvironment,
} from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-config-env-"));

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

try {
  const envConfigPath = join(workspace, "env-monitor.config.json");
  writeJsonFile(envConfigPath, {
    reservoir: {
      databasePath: "./env-monitor.sqlite",
      rollingBufferWindowMs: "5h",
    },
    replay: {
      retryBackoffMs: "9s",
    },
  });

  const envConfig = loadMonitorConfigFromEnvironment({
    cwd: workspace,
    env: {
      [MONITOR_CONFIG_ENV_VAR]: "env-monitor.config.json",
    },
  });
  assert.equal(envConfig.reservoir.databasePath, "./env-monitor.sqlite");
  assert.equal(envConfig.reservoir.rollingBufferWindowMs, 18_000_000n);
  assert.equal(envConfig.replay.retryBackoffMs, 9_000n);

  writeJsonFile(join(workspace, DEFAULT_MONITOR_CONFIG_FILE), {
    transport: {
      sourceLabel: "default-file",
    },
    throttle: {
      defaultTier: "slow",
    },
  });

  const defaultFileConfig = loadMonitorConfigFromEnvironment({
    cwd: workspace,
    env: {},
  });
  assert.equal(defaultFileConfig.transport.sourceLabel, "default-file");
  assert.equal(defaultFileConfig.throttle.defaultTier, "slow");

  const inlineOverrideConfig = resolveMonitorConfigFromEnvironment(
    {
      transport: {
        sourceLabel: "inline-override",
      },
      replay: {
        healthConfirmationHeartbeats: 7,
      },
    },
    {
      cwd: workspace,
      env: {
        [MONITOR_CONFIG_ENV_VAR]: "env-monitor.config.json",
      },
    },
  );
  assert.equal(inlineOverrideConfig.transport.sourceLabel, "inline-override");
  assert.equal(
    inlineOverrideConfig.reservoir.databasePath,
    "./env-monitor.sqlite",
  );
  assert.equal(inlineOverrideConfig.replay.healthConfirmationHeartbeats, 7);
  assert.equal(inlineOverrideConfig.replay.retryBackoffMs, 9_000n);

  const defaultsOnlyConfig = loadMonitorConfigFromEnvironment({
    cwd: join(workspace, "empty"),
    env: {},
  });
  const defaults = createDefaultMonitorConfig();
  assert.equal(
    defaultsOnlyConfig.reservoir.databasePath,
    defaults.reservoir.databasePath,
  );
  assert.equal(
    defaultsOnlyConfig.throttle.defaultTier,
    defaults.throttle.defaultTier,
  );

  assert.throws(
    () =>
      loadMonitorConfigFromEnvironment({
        cwd: workspace,
        env: {
          [MONITOR_CONFIG_ENV_VAR]: "missing.config.json",
        },
      }),
    /Failed to load monitor config from CAUSAL_ORDER_MONITOR_CONFIG/,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "config env resolution passed: inline overrides env file, env file overrides default file, and defaults apply when no file is present",
);

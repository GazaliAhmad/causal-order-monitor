import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MONITOR_CONFIG_ENV_VAR,
  createMonitorRuntime,
  createMonitorRuntimeFromEnvironment,
  createMonitorRuntimeFromFile,
  createTransportMonitorAdapterFromEnvironment,
  createTransportMonitorAdapterFromFile,
} from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-runtime-bootstrap-"));

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createHandlers() {
  return {
    deliverToDedupe: async () => {},
    deliverToOrder: async () => {},
  };
}

try {
  const fileDatabasePath = join(workspace, "from-file.sqlite");
  const fileConfigPath = join(workspace, "runtime.config.json");
  writeJsonFile(fileConfigPath, {
    reservoir: {
      databasePath: fileDatabasePath,
    },
    replay: {
      healthConfirmationHeartbeats: 4,
    },
  });

  const runtimeFromFile = createMonitorRuntimeFromFile(fileConfigPath);
  assert.equal(runtimeFromFile.getConfig().reservoir.databasePath, fileDatabasePath);
  assert.equal(runtimeFromFile.getConfig().replay.healthConfirmationHeartbeats, 4);
  runtimeFromFile.close();

  const envConfigPath = join(workspace, "env-runtime.config.json");
  const envDatabasePath = join(workspace, "env-runtime.sqlite");
  writeJsonFile(envConfigPath, {
    reservoir: {
      databasePath: envDatabasePath,
    },
    transport: {
      sourceLabel: "env-runtime",
    },
    throttle: {
      defaultTier: "slow",
    },
  });

  const runtimeFromEnvironment = createMonitorRuntimeFromEnvironment(
    {
      replay: {
        healthConfirmationHeartbeats: 9,
      },
    },
    {
      cwd: workspace,
      env: {
        [MONITOR_CONFIG_ENV_VAR]: "env-runtime.config.json",
      },
    },
  );
  assert.equal(runtimeFromEnvironment.getConfig().transport.sourceLabel, "env-runtime");
  assert.equal(runtimeFromEnvironment.getConfig().throttle.defaultTier, "slow");
  assert.equal(runtimeFromEnvironment.getConfig().replay.healthConfirmationHeartbeats, 9);
  assert.equal(runtimeFromEnvironment.getConfig().reservoir.databasePath, envDatabasePath);
  runtimeFromEnvironment.close();

  const adapterFromFile = createTransportMonitorAdapterFromFile(
    createHandlers(),
    fileConfigPath,
  );
  assert.equal(adapterFromFile.getRuntime().getConfig().reservoir.databasePath, fileDatabasePath);
  adapterFromFile.close();

  const adapterFromEnvironment = createTransportMonitorAdapterFromEnvironment(
    createHandlers(),
    {
      replay: {
        retryBackoffMs: 8_000n,
      },
    },
    {
      cwd: workspace,
      env: {
        [MONITOR_CONFIG_ENV_VAR]: "env-runtime.config.json",
      },
    },
  );
  assert.equal(adapterFromEnvironment.getRuntime().getConfig().transport.sourceLabel, "env-runtime");
  assert.equal(adapterFromEnvironment.getRuntime().getConfig().replay.retryBackoffMs, 8_000n);
  assert.equal(adapterFromEnvironment.getRuntime().getConfig().reservoir.databasePath, envDatabasePath);
  adapterFromEnvironment.close();

  const explicitRuntime = createMonitorRuntime({
    reservoir: {
      databasePath: join(workspace, "explicit-runtime.sqlite"),
    },
    transport: {
      sourceLabel: "explicit-runtime",
    },
  });
  assert.equal(explicitRuntime.getConfig().transport.sourceLabel, "explicit-runtime");
  explicitRuntime.close();
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "runtime bootstrap passed: runtime and adapter convenience creators load file/env config without breaking explicit constructor usage",
);

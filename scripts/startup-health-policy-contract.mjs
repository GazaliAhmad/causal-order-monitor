import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMonitorRuntime,
  resolveMonitorConfig,
  resolveMonitorConfigFromEnvironment,
} from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-startup-policy-"));
const databasePath = join(workspace, "monitor.sqlite");
try {
  const optimistic = createMonitorRuntime({ reservoir: { databasePath } });
  assert.equal(optimistic.getConfig().startup.healthPolicy, "optimistic");
  assert.notEqual(optimistic.getIngressDecision().action, "buffer_only");
  optimistic.close();

  const conservative = createMonitorRuntime({
    reservoir: { databasePath: join(workspace, "conservative.sqlite") },
    startup: { healthPolicy: "conservative" },
  });
  const initial = conservative.getIngressDecision();
  assert.equal(initial.action, "buffer_only");
  assert.match(initial.reason, /conservative startup awaiting health evidence/);
  for (const component of ["transport", "dedupe", "causal-order"]) {
    conservative.observeHeartbeat(component);
  }
  assert.notEqual(conservative.getIngressDecision().action, "buffer_only");
  conservative.close();

  assert.equal(
    resolveMonitorConfig({ startup: { healthPolicy: "conservative" } }).startup.healthPolicy,
    "conservative",
  );
  assert.equal(
    resolveMonitorConfigFromEnvironment(
      {},
      { env: {}, cwd: workspace },
    ).startup.healthPolicy,
    "optimistic",
  );
  const configPath = join(workspace, "monitor.config.json");
  writeFileSync(configPath, JSON.stringify({ startup: { healthPolicy: "conservative" } }));
  assert.equal(
    resolveMonitorConfigFromEnvironment(
      {},
      { env: { CAUSAL_ORDER_MONITOR_CONFIG: configPath }, cwd: workspace },
    ).startup.healthPolicy,
    "conservative",
  );
  assert.equal(
    resolveMonitorConfigFromEnvironment(
      { startup: { healthPolicy: "optimistic" } },
      { env: { CAUSAL_ORDER_MONITOR_CONFIG: configPath }, cwd: workspace },
    ).startup.healthPolicy,
    "optimistic",
  );

  console.log("Startup health policy contract passed: optimistic compatibility and conservative evidence gating are deterministic.");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MonitorRuntime } from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-auxiliary-growth-"));
const databasePath = join(workspace, "monitor.sqlite");
let now = 1_000n;
const runtime = new MonitorRuntime({
  now: () => now,
  reservoir: { databasePath },
});

function counts() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = {};
    for (const table of ["component_health_log", "replay_sessions"]) {
      const statement = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
      statement.setReadBigInts(true);
      result[table] = Number(statement.get().count);
    }
    return result;
  } finally {
    database.close();
  }
}

try {
  for (const component of ["transport", "dedupe", "causal-order"]) {
    runtime.updateComponentHealth(component, { state: "online", observedAt: now });
  }
  const saturated = counts();
  assert.ok(saturated.component_health_log > 0);
  assert.ok(saturated.replay_sessions > 0);

  for (let index = 0; index < 10_000; index += 1) {
    now += 1n;
    runtime.observeHeartbeat("transport", now);
    runtime.observeHeartbeat("dedupe", now);
    runtime.observeHeartbeat("causal-order", now);
  }

  assert.deepEqual(counts(), saturated);

  now += 1n;
  runtime.updateComponentHealth("causal-order", { state: "offline", observedAt: now });
  const transitioned = counts();
  assert.equal(transitioned.component_health_log, saturated.component_health_log + 1);
  assert.ok(transitioned.replay_sessions > saturated.replay_sessions);
} finally {
  runtime.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log("auxiliary growth contract passed: 30,000 unchanged heartbeat observations add no health-log or replay-session rows while real transitions remain persisted");

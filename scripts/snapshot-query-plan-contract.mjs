import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MonitorRuntime } from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-snapshot-query-plan-"));
const databasePath = join(workspace, "monitor.sqlite");
let nowMs = 1_000_000n;
const runtime = new MonitorRuntime({ now: () => nowMs, reservoir: { databasePath } });
try {
  runtime.updateComponentHealth("causal-order", {
    state: "offline",
    observedAt: nowMs,
    details: {},
  });
  for (let index = 0; index < 1_000; index += 1) {
    runtime.ingestTransportEvent({
      id: `query-plan-${index}`,
      nodeId: "query-plan-node",
      clock: { physicalTimeMs: nowMs + BigInt(index) },
      ingestedAt: nowMs + BigInt(index),
      payload: { index },
    });
  }
  const snapshot = runtime.getOperatorSnapshot();
  assert.equal(snapshot.backlog.totalRows, 1_000);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
} finally {
  runtime.close();
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const queries = [
    `SELECT MIN(monitor_ingest_at_ms) AS oldest FROM ingress_events WHERE replay_state IN ('pending', 'replaying')`,
    `SELECT COUNT(*) AS count, MIN(retry_not_before_ms) AS earliest_retry_at FROM ingress_events WHERE replay_state = 'pending' AND retry_not_before_ms IS NOT NULL AND retry_not_before_ms > 0`,
    `SELECT source_path, COUNT(*) AS count FROM ingress_events WHERE replay_state IN ('pending', 'replaying') GROUP BY source_path`,
    `SELECT delivery_mode, COUNT(*) AS count FROM ingress_events WHERE replay_state IN ('pending', 'replaying') GROUP BY delivery_mode`,
  ];
  assert.equal(queries.length, 4);
  for (const query of queries) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    const details = plan.map((row) => String(row.detail)).join(" | ");
    assert.match(details, /USING (?:COVERING )?INDEX idx_ingress_events_/);
    assert.doesNotMatch(details, /^SCAN ingress_events(?: |$)/);
  }
} finally {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log(
  "snapshot query-plan contract passed: four fixed reservoir aggregations remain index-backed at 1,000 pending rows",
);

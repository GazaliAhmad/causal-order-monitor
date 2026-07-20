import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createMonitorRuntime } from "../.build/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-upgrade-restart-"));
const databasePath = join(workspace, "legacy.sqlite");
const legacySchema = readFileSync(
  new URL("./fixtures/legacy-monitor-schema-v0.sql", import.meta.url),
  "utf8",
);

try {
  const db = new DatabaseSync(databasePath);
  db.exec(legacySchema);
  const insert = db.prepare(
    `INSERT INTO ingress_events (
      id, monitor_ingest_at_ms, source_node_id, source_stream_id, source_path,
      event_id, trace_id, sequence, logical_time_ms, payload_json,
      payload_encoding, delivery_mode, replay_state, replay_attempts,
      expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, id] of ["legacy-first", "legacy-second"].entries()) {
    insert.run(
      id,
      1_000 + index,
      "legacy-node",
      "legacy-stream",
      "transport_normalized_stream",
      id,
      null,
      String(index + 1),
      1_000 + index,
      JSON.stringify({
        id,
        nodeId: "legacy-node",
        clock: { physicalTimeMs: { __monitorBigInt: String(1_000 + index) } },
        payload: { id },
      }),
      "json",
      "order_buffer_only",
      "pending",
      index,
      100_000,
    );
  }
  db.close();

  const runtime = createMonitorRuntime({
    now: () => 10_000n,
    reservoir: { databasePath },
  });
  assert.deepEqual(runtime.getSchemaInfo(), {
    currentVersion: 3,
    latestSupportedVersion: 3,
    migratedFromLegacy: true,
  });
  assert.equal(runtime.getReplaySnapshot().state, "queued");
  assert.equal(runtime.getIngressDecision().action, "buffer_only");
  runtime.updateComponentHealth("dedupe", { state: "online" });
  runtime.updateComponentHealth("causal-order", { state: "online" });
  const batch = runtime.claimReplayBatch(10);
  assert.deepEqual(
    batch.entries.map((entry) => entry.event.id),
    ["legacy-first", "legacy-second"],
  );
  assert.deepEqual(
    batch.entries.map((entry) => entry.replayAttempts),
    [1, 2],
  );
  runtime.close();

  const reopened = createMonitorRuntime({
    now: () => 10_001n,
    reservoir: { databasePath },
  });
  assert.equal(reopened.getSchemaInfo().currentVersion, 3);
  assert.equal(reopened.getSchemaInfo().migratedFromLegacy, false);
  assert.equal(reopened.getReplaySnapshot().state, "queued");
  assert.equal(reopened.getReservoirStats().totalPendingRows, 2);
  reopened.close();

  console.log("Upgrade-restart contract passed.");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

import type { DatabaseSync } from "node:sqlite";

export const MONITOR_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ingress_events (
  monitor_ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  monitor_ingest_at_ms INTEGER NOT NULL,
  source_node_id TEXT NOT NULL,
  source_stream_id TEXT,
  source_path TEXT NOT NULL,
  event_id TEXT NOT NULL,
  trace_id TEXT,
  sequence TEXT,
  logical_time_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  payload_encoding TEXT NOT NULL DEFAULT 'json',
  delivery_mode TEXT NOT NULL,
  replay_state TEXT NOT NULL,
  replay_attempts INTEGER NOT NULL DEFAULT 0,
  retry_not_before_ms INTEGER,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingress_events_expires_at
  ON ingress_events(expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_state
  ON ingress_events(replay_state);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_retry
  ON ingress_events(replay_state, retry_not_before_ms);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_ingest_time
  ON ingress_events(replay_state, monitor_ingest_at_ms);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_expiry
  ON ingress_events(replay_state, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_ingress_events_source_path
  ON ingress_events(source_path);

CREATE TABLE IF NOT EXISTS component_health_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at_ms INTEGER NOT NULL,
  component TEXT NOT NULL,
  health_state TEXT NOT NULL,
  reason_code TEXT,
  details_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_component_health_log_component_time
  ON component_health_log(component, recorded_at_ms);

CREATE TABLE IF NOT EXISTS outage_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  dedupe_state TEXT NOT NULL,
  causal_order_state TEXT NOT NULL,
  buffer_mode TEXT NOT NULL,
  notes_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  target_path TEXT NOT NULL,
  session_state TEXT NOT NULL,
  event_count_attempted INTEGER NOT NULL DEFAULT 0,
  event_count_delivered INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL
);
`;

export function applyMonitorSchema(db: DatabaseSync): void {
  db.exec(MONITOR_SQLITE_SCHEMA);

  const ingressColumns = db
    .prepare(`PRAGMA table_info(ingress_events)`)
    .all() as Array<{ name?: unknown }>;
  const columnNames = new Set(
    ingressColumns
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"),
  );

  if (!columnNames.has("retry_not_before_ms")) {
    db.exec(`ALTER TABLE ingress_events ADD COLUMN retry_not_before_ms INTEGER`);
  }
}

import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MONITOR_SQLITE_SCHEMA_VERSION = 1;

export interface MonitorSchemaInfo {
  currentVersion: number;
  latestSupportedVersion: number;
  migratedFromLegacy: boolean;
}

export type MonitorSchemaErrorCode =
  | "ERR_MONITOR_SCHEMA_NEWER_THAN_SUPPORTED"
  | "ERR_MONITOR_SCHEMA_INCOMPATIBLE"
  | "ERR_MONITOR_SCHEMA_MIGRATION_FAILED";

export class MonitorSchemaError extends Error {
  readonly code: MonitorSchemaErrorCode;
  readonly databasePath: string;
  readonly detectedVersion: number | null;
  readonly latestSupportedVersion = MONITOR_SQLITE_SCHEMA_VERSION;

  constructor(
    message: string,
    options: {
      code: MonitorSchemaErrorCode;
      databasePath: string;
      detectedVersion: number | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MonitorSchemaError";
    this.code = options.code;
    this.databasePath = normalizeDatabasePath(options.databasePath);
    this.detectedVersion = options.detectedVersion;
  }
}

export class MonitorSchemaVersionError extends MonitorSchemaError {
  constructor(databasePath: string, detectedVersion: number) {
    super(
      `Monitor SQLite schema version ${detectedVersion} at "${normalizeDatabasePath(databasePath)}" ` +
        `is newer than the latest version ${MONITOR_SQLITE_SCHEMA_VERSION} supported by this package. ` +
        `Upgrade @causal-order/monitor before opening this database.`,
      {
        code: "ERR_MONITOR_SCHEMA_NEWER_THAN_SUPPORTED",
        databasePath,
        detectedVersion,
      },
    );
    this.name = "MonitorSchemaVersionError";
  }
}

export class MonitorSchemaCompatibilityError extends MonitorSchemaError {
  constructor(
    databasePath: string,
    detectedVersion: number | null,
    reason: string,
  ) {
    super(
      `Monitor SQLite schema at "${normalizeDatabasePath(databasePath)}" is incompatible or incomplete. ${reason}`,
      {
        code: "ERR_MONITOR_SCHEMA_INCOMPATIBLE",
        databasePath,
        detectedVersion,
      },
    );
    this.name = "MonitorSchemaCompatibilityError";
  }
}

export class MonitorSchemaMigrationError extends MonitorSchemaError {
  readonly fromVersion: number;
  readonly toVersion: number;

  constructor(
    databasePath: string,
    fromVersion: number,
    toVersion: number,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Failed to migrate monitor SQLite schema at "${normalizeDatabasePath(databasePath)}" ` +
        `from version ${fromVersion} to ${toVersion}. The migration was rolled back. ${reason}`,
      {
        code: "ERR_MONITOR_SCHEMA_MIGRATION_FAILED",
        databasePath,
        detectedVersion: fromVersion,
        cause,
      },
    );
    this.name = "MonitorSchemaMigrationError";
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
  }
}

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
  replay_claimed_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingress_events_expires_at
  ON ingress_events(expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_state
  ON ingress_events(replay_state);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_retry
  ON ingress_events(replay_state, retry_not_before_ms);

CREATE INDEX IF NOT EXISTS idx_ingress_events_replay_claimed
  ON ingress_events(replay_state, replay_claimed_at_ms);

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

interface MonitorSchemaMigration {
  fromVersion: number;
  toVersion: number;
  apply(db: DatabaseSync): void;
}

const REQUIRED_COLUMNS = {
  ingress_events: [
    "monitor_ingest_seq",
    "id",
    "monitor_ingest_at_ms",
    "source_node_id",
    "source_stream_id",
    "source_path",
    "event_id",
    "trace_id",
    "sequence",
    "logical_time_ms",
    "payload_json",
    "payload_encoding",
    "delivery_mode",
    "replay_state",
    "replay_attempts",
    "retry_not_before_ms",
    "replay_claimed_at_ms",
    "expires_at_ms",
  ],
  component_health_log: [
    "id",
    "recorded_at_ms",
    "component",
    "health_state",
    "reason_code",
    "details_json",
  ],
  outage_windows: [
    "id",
    "started_at_ms",
    "ended_at_ms",
    "dedupe_state",
    "causal_order_state",
    "buffer_mode",
    "notes_json",
  ],
  replay_sessions: [
    "id",
    "started_at_ms",
    "ended_at_ms",
    "target_path",
    "session_state",
    "event_count_attempted",
    "event_count_delivered",
    "error_count",
    "details_json",
  ],
} as const;

const LEGACY_OPTIONAL_INGRESS_COLUMNS = new Set([
  "retry_not_before_ms",
  "replay_claimed_at_ms",
]);

const MONITOR_SCHEMA_MIGRATIONS: ReadonlyArray<MonitorSchemaMigration> = [
  {
    fromVersion: 0,
    toVersion: 1,
    apply(db) {
      const ingressColumns = getColumnNames(db, "ingress_events");
      if (!ingressColumns.has("retry_not_before_ms")) {
        db.exec(`ALTER TABLE ingress_events ADD COLUMN retry_not_before_ms INTEGER`);
      }
      if (!ingressColumns.has("replay_claimed_at_ms")) {
        db.exec(`ALTER TABLE ingress_events ADD COLUMN replay_claimed_at_ms INTEGER`);
      }
      db.exec(MONITOR_SQLITE_SCHEMA);
    },
  },
];

function normalizeDatabasePath(databasePath: string): string {
  return databasePath === ":memory:" ? databasePath : resolve(databasePath);
}

function parseInteger(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value ?? 0);
}

function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(`PRAGMA user_version`).get() as
    | { user_version?: unknown }
    | undefined;
  return parseInteger(row?.user_version);
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError(`Invalid monitor schema version '${version}'.`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

function getUserTableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name?: unknown }>;
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function getColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function validateSchemaStructure(
  db: DatabaseSync,
  databasePath: string,
  detectedVersion: number,
  allowLegacyIngressColumns: boolean,
): void {
  const tableNames = getUserTableNames(db);
  const missingTables = Object.keys(REQUIRED_COLUMNS).filter(
    (tableName) => !tableNames.has(tableName),
  );
  if (missingTables.length > 0) {
    throw new MonitorSchemaCompatibilityError(
      databasePath,
      detectedVersion,
      `Missing required table(s): ${missingTables.join(", ")}.`,
    );
  }

  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columnNames = getColumnNames(db, tableName);
    const missingColumns = requiredColumns.filter((columnName) => {
      if (
        allowLegacyIngressColumns &&
        tableName === "ingress_events" &&
        LEGACY_OPTIONAL_INGRESS_COLUMNS.has(columnName)
      ) {
        return false;
      }
      return !columnNames.has(columnName);
    });
    if (missingColumns.length > 0) {
      throw new MonitorSchemaCompatibilityError(
        databasePath,
        detectedVersion,
        `Table '${tableName}' is missing required column(s): ${missingColumns.join(", ")}.`,
      );
    }
  }
}

function withSchemaTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the migration or validation failure that caused the rollback.
    }
    throw error;
  }
}

function createCurrentSchema(db: DatabaseSync): void {
  db.exec(MONITOR_SQLITE_SCHEMA);
  setSchemaVersion(db, MONITOR_SQLITE_SCHEMA_VERSION);
}

function migrateLegacySchema(db: DatabaseSync, databasePath: string): void {
  let currentVersion = 0;
  while (currentVersion < MONITOR_SQLITE_SCHEMA_VERSION) {
    const migration = MONITOR_SCHEMA_MIGRATIONS.find(
      (candidate) => candidate.fromVersion === currentVersion,
    );
    if (!migration) {
      throw new MonitorSchemaCompatibilityError(
        databasePath,
        currentVersion,
        `No migration path exists from version ${currentVersion}.`,
      );
    }
    try {
      migration.apply(db);
      setSchemaVersion(db, migration.toVersion);
      currentVersion = migration.toVersion;
    } catch (error) {
      if (error instanceof MonitorSchemaError) {
        throw error;
      }
      throw new MonitorSchemaMigrationError(
        databasePath,
        migration.fromVersion,
        migration.toVersion,
        error,
      );
    }
  }
}

export function applyMonitorSchema(
  db: DatabaseSync,
  databasePath = ":memory:",
): MonitorSchemaInfo {
  const detectedVersion = getSchemaVersion(db);
  if (detectedVersion > MONITOR_SQLITE_SCHEMA_VERSION) {
    throw new MonitorSchemaVersionError(databasePath, detectedVersion);
  }

  const tableNames = getUserTableNames(db);
  if (detectedVersion === 0 && tableNames.size === 0) {
    withSchemaTransaction(db, () => createCurrentSchema(db));
    return {
      currentVersion: MONITOR_SQLITE_SCHEMA_VERSION,
      latestSupportedVersion: MONITOR_SQLITE_SCHEMA_VERSION,
      migratedFromLegacy: false,
    };
  }

  if (detectedVersion === 0) {
    validateSchemaStructure(db, databasePath, detectedVersion, true);
    withSchemaTransaction(db, () => migrateLegacySchema(db, databasePath));
    validateSchemaStructure(
      db,
      databasePath,
      MONITOR_SQLITE_SCHEMA_VERSION,
      false,
    );
    return {
      currentVersion: MONITOR_SQLITE_SCHEMA_VERSION,
      latestSupportedVersion: MONITOR_SQLITE_SCHEMA_VERSION,
      migratedFromLegacy: true,
    };
  }

  validateSchemaStructure(db, databasePath, detectedVersion, false);
  db.exec(MONITOR_SQLITE_SCHEMA);
  return {
    currentVersion: detectedVersion,
    latestSupportedVersion: MONITOR_SQLITE_SCHEMA_VERSION,
    migratedFromLegacy: false,
  };
}

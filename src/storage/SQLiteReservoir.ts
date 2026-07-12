import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { MonitorReservoirConfig } from "../types/config.js";
import type {
  MonitorDeliveryMode,
  MonitorIngressEvent,
  MonitorSourcePath,
} from "../types/events.js";
import type {
  MonitorComponentHealthSnapshot,
  ReplaySessionSnapshot,
  ReservoirStats,
} from "../types/snapshots.js";
import {
  applyMonitorSchema,
  MonitorSchemaError,
  type MonitorSchemaInfo,
} from "./schema.js";

interface ReservoirIngressOptions {
  sourcePath: MonitorSourcePath;
  deliveryMode: MonitorDeliveryMode;
  sourceStreamId?: string | null;
  replayState?: ReservoirReplayState;
  retryNotBeforeMs?: bigint | null;
  monitorIngestAt?: bigint;
  fullOutageActive?: boolean;
}

type ReservoirReplayState =
  | "pending"
  | "replaying"
  | "delivered"
  | "dead_letter";

export interface ReservoirReplayEntry {
  rowId: number;
  event: MonitorIngressEvent;
  sourcePath: MonitorSourcePath;
  sourceStreamId: string | null;
  deliveryMode: MonitorDeliveryMode;
  replayAttempts: number;
}

interface PruneResult {
  markedDeadLetter: number;
  deletedRows: number;
}

export interface ReservoirRestartState {
  totalPendingRows: number;
  retryWaitingRows: number;
  earliestRetryAt: bigint | null;
  maximumReplayAttempts: number;
  reclaimedInterruptedRows: number;
}

interface PruneBatchRow {
  row_id: bigint;
}

const BIGINT_SENTINEL = "__monitorBigInt";

const INSERT_INGRESS_EVENT_SQL = `INSERT INTO ingress_events (
  id,
  monitor_ingest_at_ms,
  source_node_id,
  source_stream_id,
  source_path,
  event_id,
  trace_id,
  sequence,
  logical_time_ms,
  payload_json,
  payload_encoding,
  delivery_mode,
  replay_state,
  replay_attempts,
  retry_not_before_ms,
  replay_claimed_at_ms,
  expires_at_ms
) VALUES (
  @id,
  @monitor_ingest_at_ms,
  @source_node_id,
  @source_stream_id,
  @source_path,
  @event_id,
  @trace_id,
  @sequence,
  @logical_time_ms,
  @payload_json,
  @payload_encoding,
  @delivery_mode,
  @replay_state,
  @replay_attempts,
  @retry_not_before_ms,
  @replay_claimed_at_ms,
  @expires_at_ms
)`;

function normalizeDatabasePath(databasePath: string): string {
  return databasePath === ":memory:" ? databasePath : resolve(databasePath);
}

function toReservoirStartupError(
  databasePath: string,
  error: unknown,
): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const resolvedPath = normalizeDatabasePath(databasePath);
  return new Error(
    `Failed to initialize monitor SQLite reservoir at "${resolvedPath}". ` +
      `Ensure the path is on a writable local filesystem for this host process. ` +
      `Recommended examples are "./.causal-order-monitor/monitor.sqlite" during development ` +
      `or a server-local path such as "/var/lib/causal-order-monitor/monitor.sqlite" in production. ` +
      `Avoid read-only mounts, synced workspace folders, and unvalidated network filesystems. ` +
      `SQLite startup error: ${reason}`,
  );
}

function toSqlBigInt(value: bigint): bigint {
  return value;
}

function parseCount(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

function parseBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }
  return 0n;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) =>
    typeof currentValue === "bigint"
      ? {
          [BIGINT_SENTINEL]: currentValue.toString(),
        }
      : currentValue,
  );
}

function deserializeJson<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue) => {
    if (
      currentValue &&
      typeof currentValue === "object" &&
      BIGINT_SENTINEL in currentValue &&
      typeof currentValue[BIGINT_SENTINEL] === "string"
    ) {
      return BigInt(currentValue[BIGINT_SENTINEL]);
    }

    return currentValue;
  }) as T;
}

export class SQLiteReservoir {
  readonly #config: MonitorReservoirConfig;
  readonly #now: () => bigint;
  readonly #db: DatabaseSync;
  readonly #schemaInfo: MonitorSchemaInfo;
  readonly #appendIngressStatement: StatementSync;
  #pendingRowCount: number;

  constructor(config: MonitorReservoirConfig, now: () => bigint) {
    this.#config = config;
    this.#now = now;
    let db: DatabaseSync | undefined;
    try {
      if (config.databasePath !== ":memory:") {
        mkdirSync(dirname(normalizeDatabasePath(config.databasePath)), {
          recursive: true,
        });
      }
      db = new DatabaseSync(config.databasePath);
      this.#db = db;
      this.#schemaInfo = applyMonitorSchema(db, config.databasePath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      this.#appendIngressStatement = db.prepare(INSERT_INGRESS_EVENT_SQL);
      this.#pendingRowCount = this.#readPendingRowCount();
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Preserve the startup failure that prevented reservoir initialization.
      }
      if (error instanceof MonitorSchemaError) {
        throw error;
      }
      throw toReservoirStartupError(config.databasePath, error);
    }
  }

  getSchemaInfo(): Readonly<MonitorSchemaInfo> {
    return { ...this.#schemaInfo };
  }

  appendIngressEvent(
    event: MonitorIngressEvent,
    options: ReservoirIngressOptions,
  ): number {
    const monitorIngestAt = options.monitorIngestAt ?? event.ingestedAt ?? this.#now();
    const retentionWindowMs = options.fullOutageActive
      ? this.#config.fullOutageMaxWindowMs
      : this.#config.rollingBufferWindowMs;
    const expiresAt = monitorIngestAt + retentionWindowMs;
    const replayState =
      options.replayState ??
      (options.sourcePath === "deduped_observation" ? "delivered" : "pending");

    const result = this.#appendIngressStatement.run({
      id: event.id,
      monitor_ingest_at_ms: toSqlBigInt(monitorIngestAt),
      source_node_id: event.nodeId,
      source_stream_id: options.sourceStreamId ?? null,
      source_path: options.sourcePath,
      event_id: event.id,
      trace_id: event.traceId ?? event.payload.traceId ?? null,
      sequence: event.sequence?.toString() ?? null,
      logical_time_ms: toSqlBigInt(event.clock.physicalTimeMs),
      payload_json: serializeJson(event),
      payload_encoding: "json",
      delivery_mode: options.deliveryMode,
      replay_state: replayState,
      replay_attempts: 0,
      retry_not_before_ms:
        options.retryNotBeforeMs === null || options.retryNotBeforeMs === undefined
          ? null
          : toSqlBigInt(options.retryNotBeforeMs),
      replay_claimed_at_ms: null,
      expires_at_ms: toSqlBigInt(expiresAt),
    });

    if (replayState === "pending" || replayState === "replaying") {
      this.#pendingRowCount += 1;
    }

    return Number(result.lastInsertRowid);
  }

  recordHealthTransition(snapshot: MonitorComponentHealthSnapshot): number {
    const result = this.#prepare(
      `INSERT INTO component_health_log (
          recorded_at_ms,
          component,
          health_state,
          reason_code,
          details_json
        ) VALUES (
          @recorded_at_ms,
          @component,
          @health_state,
          @reason_code,
          @details_json
        )`,
    ).run({
      recorded_at_ms: toSqlBigInt(snapshot.observedAt),
      component: snapshot.component,
      health_state: snapshot.state,
      reason_code: snapshot.reasonCode,
      details_json: serializeJson(snapshot.details),
    });

    return Number(result.lastInsertRowid);
  }

  recordReplaySnapshot(snapshot: ReplaySessionSnapshot): number {
    const result = this.#prepare(
      `INSERT INTO replay_sessions (
          started_at_ms,
          ended_at_ms,
          target_path,
          session_state,
          event_count_attempted,
          event_count_delivered,
          error_count,
          details_json
        ) VALUES (
          @started_at_ms,
          @ended_at_ms,
          @target_path,
          @session_state,
          @event_count_attempted,
          @event_count_delivered,
          @error_count,
          @details_json
        )`,
    ).run({
      started_at_ms:
        snapshot.startedAt === null ? null : toSqlBigInt(snapshot.startedAt),
      ended_at_ms:
        snapshot.endedAt === null ? null : toSqlBigInt(snapshot.endedAt),
      target_path: snapshot.targetPath,
      session_state: snapshot.state,
      event_count_attempted: snapshot.queuedEventCount,
      event_count_delivered: snapshot.deliveredEventCount,
      error_count: snapshot.lastError ? 1 : 0,
      details_json: serializeJson({
        lastError: snapshot.lastError,
        nextRetryAt: snapshot.nextRetryAt,
        consecutiveFailureCount: snapshot.consecutiveFailureCount,
        recoveryHeartbeatCount: snapshot.recoveryHeartbeatCount,
        requiredRecoveryHeartbeats: snapshot.requiredRecoveryHeartbeats,
      }),
    });

    return Number(result.lastInsertRowid);
  }

  bumpReplayAttempts(
    limitToStates: ReadonlyArray<ReservoirReplayState> = [],
  ): number {
    const pendingStates =
      limitToStates.length === 0 ? ["pending", "replaying"] : limitToStates;
    const placeholders = pendingStates.map(() => "?").join(", ");
    const result = this.#prepare(
      `UPDATE ingress_events
         SET replay_attempts = replay_attempts + 1
         WHERE replay_state IN (${placeholders})`,
    ).run(...pendingStates);
    return Number(result.changes);
  }

  updateReplayState(
    fromStates: ReadonlyArray<ReservoirReplayState>,
    nextState: ReservoirReplayState,
  ): number {
    const placeholders = fromStates.map(() => "?").join(", ");
    const result = this.#prepare(
      `UPDATE ingress_events
         SET replay_state = ?
         WHERE replay_state IN (${placeholders})`,
    ).run(nextState, ...fromStates);
    const changedRows = Number(result.changes);
    if (changedRows > 0) {
      this.#pendingRowCount = this.#readPendingRowCount();
    }
    return changedRows;
  }

  claimReplayBatch(
    limit: number,
    deliveryMode: MonitorDeliveryMode = "replay_through_dedupe",
  ): ReservoirReplayEntry[] {
    if (limit <= 0) {
      return [];
    }

    return this.#withTransaction(() => {
      const rows = this.#prepareReadBigInts(
        `SELECT
               rowid AS row_id,
               payload_json,
               source_path,
               source_stream_id,
               replay_attempts
             FROM ingress_events
             WHERE replay_state = 'pending'
               AND (retry_not_before_ms IS NULL OR retry_not_before_ms <= ?)
             ORDER BY monitor_ingest_at_ms ASC, rowid ASC
             LIMIT ?`,
      ).all(toSqlBigInt(this.#now()), limit) as Array<{
        row_id: bigint;
        payload_json: string;
        source_path: MonitorSourcePath;
        source_stream_id: string | null;
        replay_attempts: bigint;
      }>;

      if (rows.length === 0) {
        return [];
      }

      const ids = rows.map((row) => Number(row.row_id));
      const placeholders = ids.map(() => "?").join(", ");

      this.#prepare(
        `UPDATE ingress_events
             SET replay_state = 'replaying',
                 replay_attempts = replay_attempts + 1,
                 retry_not_before_ms = NULL,
                 replay_claimed_at_ms = ?,
                 delivery_mode = ?
             WHERE rowid IN (${placeholders})`,
      ).run(toSqlBigInt(this.#now()), deliveryMode, ...ids);

      return rows.map((row) => ({
        rowId: Number(row.row_id),
        event: deserializeJson<MonitorIngressEvent>(row.payload_json),
        sourcePath: row.source_path,
        sourceStreamId: row.source_stream_id,
        deliveryMode,
        replayAttempts: Number(row.replay_attempts) + 1,
      }));
    });
  }

  markReplayBatchDelivered(rowIds: ReadonlyArray<number>): number {
    return this.#updateReplayRows(rowIds, "delivered", null);
  }

  markIngressRowsDelivered(rowIds: ReadonlyArray<number>): number {
    return this.#updateReplayRows(rowIds, "delivered", null);
  }

  resetReplayBatchToPending(
    rowIds: ReadonlyArray<number>,
    retryNotBeforeMs?: bigint | null,
  ): number {
    return this.#updateReplayRows(rowIds, "pending", retryNotBeforeMs);
  }

  deadLetterReplayBatch(rowIds: ReadonlyArray<number>): number {
    return this.#updateReplayRows(rowIds, "dead_letter", null);
  }

  reclaimStaleReplayRows(maxClaimAgeMs: bigint): number {
    if (maxClaimAgeMs < 0n) {
      return 0;
    }

    const staleClaimCutoff = this.#now() - maxClaimAgeMs;
    let totalReclaimed = 0;

    while (true) {
      const reclaimedThisPass = this.#withTransaction(() => {
        const rowIds = this.#selectStaleReplayingRowIds(staleClaimCutoff);
        return this.#updateReplayRows(rowIds, "pending", null);
      });

      if (reclaimedThisPass === 0) {
        return totalReclaimed;
      }

      totalReclaimed += reclaimedThisPass;
    }
  }

  recoverRestartState(): ReservoirRestartState {
    const reclaimedInterruptedRows = this.#withTransaction(() => {
      const result = this.#prepare(
        `UPDATE ingress_events
           SET replay_state = 'pending',
               replay_claimed_at_ms = NULL
           WHERE replay_state = 'replaying'`,
      ).run();
      return Number(result.changes);
    });

    if (reclaimedInterruptedRows > 0) {
      this.#pendingRowCount = this.#readPendingRowCount();
    }

    const stats = this.getStats();
    const attemptRow = this.#prepareReadBigInts(
      `SELECT MAX(replay_attempts) AS maximum_replay_attempts
         FROM ingress_events
         WHERE replay_state = 'pending'`,
    ).get() as { maximum_replay_attempts?: unknown };

    return {
      totalPendingRows: stats.totalPendingRows,
      retryWaitingRows: stats.retryWaitingRows,
      earliestRetryAt: stats.earliestRetryAt,
      maximumReplayAttempts: parseCount(attemptRow.maximum_replay_attempts),
      reclaimedInterruptedRows,
    };
  }

  pruneExpired(fullOutageActive = false): PruneResult {
    const now = this.#now();
    const rollingWindowMs = fullOutageActive
      ? this.#config.fullOutageMaxWindowMs
      : this.#config.rollingBufferWindowMs;
    const rollingCutoff = now - rollingWindowMs;
    const hardCutoff = now - this.#config.fullOutageMaxWindowMs;
    const markedDeadLetter = this.#markExpiredPendingRows(
      hardCutoff,
      rollingCutoff,
    );
    const deletedRows = this.#deleteExpiredTerminalRows(now);
    return {
      markedDeadLetter,
      deletedRows,
    };
  }

  getStats(): ReservoirStats {
    const totalPendingRows = this.getPendingRowCount();

    const oldestPendingRow = this.#prepareReadBigInts(
      `SELECT MIN(monitor_ingest_at_ms) AS oldest
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')`,
    ).get() as { oldest?: unknown };

    const retryWaitingRow = this.#prepareReadBigInts(
      `SELECT
           COUNT(*) AS count,
           MIN(retry_not_before_ms) AS earliest_retry_at
         FROM ingress_events
         WHERE replay_state = 'pending'
           AND retry_not_before_ms IS NOT NULL
           AND retry_not_before_ms > ?`,
    ).get(toSqlBigInt(this.#now())) as {
      count?: unknown;
      earliest_retry_at?: unknown;
    };

    const bySourceRows = this.#prepareReadBigInts(
      `SELECT source_path, COUNT(*) AS count
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')
         GROUP BY source_path`,
    ).all() as Array<{ source_path: MonitorSourcePath; count: unknown }>;

    const byDeliveryRows = this.#prepareReadBigInts(
      `SELECT delivery_mode, COUNT(*) AS count
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')
         GROUP BY delivery_mode`,
    ).all() as Array<{ delivery_mode: MonitorDeliveryMode; count: unknown }>;

    const sourceCounts: ReservoirStats["pendingRowsBySourcePath"] = {
      transport_normalized_stream: 0,
      deduped_observation: 0,
    };

    for (const row of bySourceRows) {
      sourceCounts[row.source_path] = parseCount(row.count);
    }

    const deliveryCounts: ReservoirStats["pendingRowsByDeliveryMode"] = {};
    for (const row of byDeliveryRows) {
      deliveryCounts[row.delivery_mode] = parseCount(row.count);
    }

    const oldestPendingAt = parseBigInt(oldestPendingRow.oldest);
    const oldestPendingAgeMs =
      oldestPendingAt === 0n ? 0n : this.#now() - oldestPendingAt;
    const earliestRetryAtRaw = parseBigInt(retryWaitingRow.earliest_retry_at);

    return {
      totalPendingRows,
      oldestPendingAgeMs,
      retryWaitingRows: parseCount(retryWaitingRow.count),
      earliestRetryAt: earliestRetryAtRaw === 0n ? null : earliestRetryAtRaw,
      pendingRowsBySourcePath: sourceCounts,
      pendingRowsByDeliveryMode: deliveryCounts,
    };
  }

  getPendingRowCount(): number {
    return this.#pendingRowCount;
  }

  #readPendingRowCount(): number {
    const row = this.#prepareReadBigInts(
      `SELECT COUNT(*) AS count
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')`,
    ).get() as { count?: unknown };
    return parseCount(row.count);
  }

  getDatabasePath(): string {
    return this.#config.databasePath;
  }

  close(): void {
    this.#db.close();
  }

  #updateReplayRows(
    rowIds: ReadonlyArray<number>,
    nextState: ReservoirReplayState,
    retryNotBeforeMs?: bigint | null,
  ): number {
    if (rowIds.length === 0) {
      return 0;
    }

    const placeholders = rowIds.map(() => "?").join(", ");
    const result = this.#prepare(
      `UPDATE ingress_events
         SET replay_state = ?,
             retry_not_before_ms = ?,
             replay_claimed_at_ms = NULL
         WHERE rowid IN (${placeholders})`,
    ).run(
      nextState,
      retryNotBeforeMs === null || retryNotBeforeMs === undefined
        ? null
        : toSqlBigInt(retryNotBeforeMs),
      ...rowIds,
    );
    const changedRows = Number(result.changes);
    if (changedRows > 0) {
      this.#pendingRowCount = this.#readPendingRowCount();
    }
    return changedRows;
  }

  #markExpiredPendingRows(
    hardCutoff: bigint,
    rollingCutoff: bigint,
  ): number {
    const pendingBatchSize = this.#config.pruneBatchSize;
    let totalMarked = 0;

    while (true) {
      const markedThisPass = this.#withTransaction(() => {
        const rowIds = this.#selectExpiredPendingRowIds(
          hardCutoff,
          rollingCutoff,
          pendingBatchSize,
        );
        return this.#updateReplayRows(rowIds, "dead_letter", null);
      });
      if (markedThisPass === 0) {
        return totalMarked;
      }

      totalMarked += markedThisPass;
    }
  }

  #deleteExpiredTerminalRows(now: bigint): number {
    const deleteBatchSize = this.#config.pruneBatchSize;
    let totalDeleted = 0;

    while (true) {
      const deletedThisPass = this.#withTransaction(() => {
        const rowIds = this.#selectExpiredTerminalRowIds(now, deleteBatchSize);
        return this.#deleteRowsByIds(rowIds);
      });
      if (deletedThisPass === 0) {
        return totalDeleted;
      }

      totalDeleted += deletedThisPass;
    }
  }

  #selectExpiredPendingRowIds(
    hardCutoff: bigint,
    rollingCutoff: bigint,
    limit: number,
  ): number[] {
    const rows = this.#prepareReadBigInts(
      `SELECT rowid AS row_id
         FROM ingress_events
         WHERE replay_state = 'pending'
           AND (
             monitor_ingest_at_ms <= @hard_cutoff
             OR (
               retry_not_before_ms IS NULL
               AND monitor_ingest_at_ms <= @rolling_cutoff
             )
           )
         ORDER BY monitor_ingest_at_ms ASC, rowid ASC
         LIMIT @limit`,
    ).all({
      hard_cutoff: toSqlBigInt(hardCutoff),
      rolling_cutoff: toSqlBigInt(rollingCutoff),
      limit,
    }) as unknown as PruneBatchRow[];

    return rows.map((row) => Number(row.row_id));
  }

  #selectStaleReplayingRowIds(staleClaimCutoff: bigint): number[] {
    const rows = this.#prepareReadBigInts(
      `SELECT rowid AS row_id
         FROM ingress_events
         WHERE replay_state = 'replaying'
           AND (
             replay_claimed_at_ms IS NULL
             OR replay_claimed_at_ms <= @stale_claim_cutoff
           )
         ORDER BY monitor_ingest_at_ms ASC, rowid ASC
         LIMIT @limit`,
    ).all({
      stale_claim_cutoff: toSqlBigInt(staleClaimCutoff),
      limit: this.#config.pruneBatchSize,
    }) as unknown as PruneBatchRow[];

    return rows.map((row) => Number(row.row_id));
  }

  #selectExpiredTerminalRowIds(now: bigint, limit: number): number[] {
    const rows = this.#prepareReadBigInts(
      `SELECT rowid AS row_id
         FROM ingress_events
         WHERE replay_state IN ('delivered', 'dead_letter')
           AND expires_at_ms <= @expires_at_ms
         ORDER BY expires_at_ms ASC, rowid ASC
         LIMIT @limit`,
    ).all({
      expires_at_ms: toSqlBigInt(now),
      limit,
    }) as unknown as PruneBatchRow[];

    return rows.map((row) => Number(row.row_id));
  }

  #deleteRowsByIds(rowIds: ReadonlyArray<number>): number {
    if (rowIds.length === 0) {
      return 0;
    }

    const placeholders = rowIds.map(() => "?").join(", ");
    const result = this.#prepare(
      `DELETE FROM ingress_events
         WHERE rowid IN (${placeholders})`,
    ).run(...rowIds);
    return Number(result.changes);
  }

  #prepare(sql: string): StatementSync {
    return this.#db.prepare(sql);
  }

  #prepareReadBigInts(sql: string): StatementSync {
    const statement = this.#db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  #withTransaction<T>(work: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#pendingRowCount = this.#readPendingRowCount();
      throw error;
    }
  }
}

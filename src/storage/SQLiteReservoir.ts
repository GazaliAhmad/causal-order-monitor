import Database from "better-sqlite3";

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
import { applyMonitorSchema } from "./schema.js";

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

const BIGINT_SENTINEL = "__monitorBigInt";

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
  readonly #db: InstanceType<typeof Database>;

  constructor(config: MonitorReservoirConfig, now: () => bigint) {
    this.#config = config;
    this.#now = now;
    this.#db = new Database(config.databasePath);
    applyMonitorSchema(this.#db);
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

    const result = this.#db
      .prepare(
        `INSERT INTO ingress_events (
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
          @expires_at_ms
        )`,
      )
      .run({
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
        expires_at_ms: toSqlBigInt(expiresAt),
      });

    return Number(result.lastInsertRowid);
  }

  recordHealthTransition(snapshot: MonitorComponentHealthSnapshot): number {
    const result = this.#db
      .prepare(
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
      )
      .run({
        recorded_at_ms: toSqlBigInt(snapshot.observedAt),
        component: snapshot.component,
        health_state: snapshot.state,
        reason_code: snapshot.reasonCode,
        details_json: serializeJson(snapshot.details),
      });

    return Number(result.lastInsertRowid);
  }

  recordReplaySnapshot(snapshot: ReplaySessionSnapshot): number {
    const result = this.#db
      .prepare(
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
      )
      .run({
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
    const result = this.#db
      .prepare(
        `UPDATE ingress_events
         SET replay_attempts = replay_attempts + 1
         WHERE replay_state IN (${placeholders})`,
      )
      .run(...pendingStates);
    return result.changes;
  }

  updateReplayState(
    fromStates: ReadonlyArray<ReservoirReplayState>,
    nextState: ReservoirReplayState,
  ): number {
    const placeholders = fromStates.map(() => "?").join(", ");
    const result = this.#db
      .prepare(
        `UPDATE ingress_events
         SET replay_state = ?
         WHERE replay_state IN (${placeholders})`,
      )
      .run(nextState, ...fromStates);
    return result.changes;
  }

  claimReplayBatch(
    limit: number,
    deliveryMode: MonitorDeliveryMode = "replay_through_dedupe",
  ): ReservoirReplayEntry[] {
    if (limit <= 0) {
      return [];
    }

    const claim = this.#db.transaction(
      (
        nowMs: bigint,
        batchLimit: number,
        nextDeliveryMode: MonitorDeliveryMode,
      ): ReservoirReplayEntry[] => {
        const rows = this.#db
          .prepare(
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
          )
          .all(toSqlBigInt(nowMs), batchLimit) as Array<{
          row_id: number;
          payload_json: string;
          source_path: MonitorSourcePath;
          source_stream_id: string | null;
          replay_attempts: number;
        }>;

        if (rows.length === 0) {
          return [];
        }

        const ids = rows.map((row) => row.row_id);
        const placeholders = ids.map(() => "?").join(", ");

        this.#db
          .prepare(
            `UPDATE ingress_events
             SET replay_state = 'replaying',
                 replay_attempts = replay_attempts + 1,
                 retry_not_before_ms = NULL,
                 delivery_mode = ?
             WHERE rowid IN (${placeholders})`,
          )
          .run(nextDeliveryMode, ...ids);

        return rows.map((row) => ({
          rowId: row.row_id,
          event: deserializeJson<MonitorIngressEvent>(row.payload_json),
          sourcePath: row.source_path,
          sourceStreamId: row.source_stream_id,
          deliveryMode: nextDeliveryMode,
          replayAttempts: row.replay_attempts + 1,
        }));
      },
    );

    return claim(this.#now(), limit, deliveryMode);
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

  pruneExpired(fullOutageActive = false): PruneResult {
    const now = this.#now();
    const rollingWindowMs = fullOutageActive
      ? this.#config.fullOutageMaxWindowMs
      : this.#config.rollingBufferWindowMs;
    const rollingCutoff = now - rollingWindowMs;
    const hardCutoff = now - this.#config.fullOutageMaxWindowMs;

    const markResult = this.#db
      .prepare(
        `UPDATE ingress_events
         SET replay_state = 'dead_letter'
         WHERE replay_state IN ('pending')
           AND (
             monitor_ingest_at_ms <= @hard_cutoff
             OR (
               retry_not_before_ms IS NULL
               AND monitor_ingest_at_ms <= @rolling_cutoff
             )
           )`,
      )
      .run({
        hard_cutoff: toSqlBigInt(hardCutoff),
        rolling_cutoff: toSqlBigInt(rollingCutoff),
      });

    const deleteResult = this.#db
      .prepare(
        `DELETE FROM ingress_events
         WHERE replay_state IN ('delivered', 'dead_letter')
           AND expires_at_ms <= ?`,
      )
      .run(toSqlBigInt(now));

    return {
      markedDeadLetter: markResult.changes,
      deletedRows: deleteResult.changes,
    };
  }

  getStats(): ReservoirStats {
    const totalPendingRow = this.#db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')`,
      )
      .get() as { count?: unknown };

    const oldestPendingRow = this.#db
      .prepare(
        `SELECT MIN(monitor_ingest_at_ms) AS oldest
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')`,
      )
      .get() as { oldest?: unknown };

    const retryWaitingRow = this.#db
      .prepare(
        `SELECT
           COUNT(*) AS count,
           MIN(retry_not_before_ms) AS earliest_retry_at
         FROM ingress_events
         WHERE replay_state = 'pending'
           AND retry_not_before_ms IS NOT NULL
           AND retry_not_before_ms > ?`,
      )
      .get(toSqlBigInt(this.#now())) as {
      count?: unknown;
      earliest_retry_at?: unknown;
    };

    const bySourceRows = this.#db
      .prepare(
        `SELECT source_path, COUNT(*) AS count
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')
         GROUP BY source_path`,
      )
      .all() as Array<{ source_path: MonitorSourcePath; count: unknown }>;

    const byDeliveryRows = this.#db
      .prepare(
        `SELECT delivery_mode, COUNT(*) AS count
         FROM ingress_events
         WHERE replay_state IN ('pending', 'replaying')
         GROUP BY delivery_mode`,
      )
      .all() as Array<{ delivery_mode: MonitorDeliveryMode; count: unknown }>;

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
      totalPendingRows: parseCount(totalPendingRow.count),
      oldestPendingAgeMs,
      retryWaitingRows: parseCount(retryWaitingRow.count),
      earliestRetryAt: earliestRetryAtRaw === 0n ? null : earliestRetryAtRaw,
      pendingRowsBySourcePath: sourceCounts,
      pendingRowsByDeliveryMode: deliveryCounts,
    };
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
    const result = this.#db
      .prepare(
        `UPDATE ingress_events
         SET replay_state = ?,
             retry_not_before_ms = ?
         WHERE rowid IN (${placeholders})`,
      )
      .run(
        nextState,
        retryNotBeforeMs === null || retryNotBeforeMs === undefined
          ? null
          : toSqlBigInt(retryNotBeforeMs),
        ...rowIds,
      );
    return result.changes;
  }
}

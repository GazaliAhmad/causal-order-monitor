import type { MonitorReplayConfig } from "../types/config.js";
import type { MonitorComponent, MonitorHealthState } from "../types/events.js";
import type { ReplaySessionSnapshot } from "../types/snapshots.js";
import type { MonitorLifecyclePublisher } from "../types/lifecycle.js";
import {
  SQLiteReservoir,
  type ReservoirReplayEntry,
} from "../storage/SQLiteReservoir.js";

export interface ReplayBatch {
  session: ReplaySessionSnapshot;
  entries: ReservoirReplayEntry[];
  isDrainComplete: boolean;
}

function createSnapshot(
  requiredRecoveryHeartbeats: number,
): ReplaySessionSnapshot {
  return {
    state: "idle",
    targetPath: "dedupe_then_order",
    queuedEventCount: 0,
    deliveredEventCount: 0,
    startedAt: null,
    endedAt: null,
    lastError: null,
    nextRetryAt: null,
    consecutiveFailureCount: 0,
    recoveryHeartbeatCount: 0,
    requiredRecoveryHeartbeats,
  };
}

export class ReplayCoordinator {
  readonly #config: MonitorReplayConfig;
  readonly #reservoir: SQLiteReservoir;
  readonly #now: () => bigint;
  readonly #publishLifecycle: MonitorLifecyclePublisher | null;
  #snapshot: ReplaySessionSnapshot;

  constructor(
    config: MonitorReplayConfig,
    reservoir: SQLiteReservoir,
    now: () => bigint,
    publishLifecycle: MonitorLifecyclePublisher | null = null,
  ) {
    this.#config = config;
    this.#reservoir = reservoir;
    this.#now = now;
    this.#publishLifecycle = publishLifecycle;
    this.#snapshot = this.#createRestartSnapshot();
  }

  #createRestartSnapshot(): ReplaySessionSnapshot {
    const restart = this.#reservoir.recoverRestartState();
    if (restart.totalPendingRows === 0) {
      return createSnapshot(this.#config.healthConfirmationHeartbeats);
    }

    const retryWaiting =
      restart.retryWaitingRows === restart.totalPendingRows &&
      restart.earliestRetryAt !== null;

    return {
      state: retryWaiting ? "failed" : "queued",
      targetPath: "dedupe_then_order",
      queuedEventCount: restart.totalPendingRows,
      deliveredEventCount: 0,
      startedAt: null,
      endedAt: null,
      lastError: retryWaiting
        ? "Replay retry is waiting after process restart."
        : null,
      nextRetryAt: retryWaiting ? restart.earliestRetryAt : null,
      consecutiveFailureCount: restart.maximumReplayAttempts,
      recoveryHeartbeatCount: 0,
      requiredRecoveryHeartbeats: this.#config.healthConfirmationHeartbeats,
    };
  }

  getSnapshot(): ReplaySessionSnapshot {
    return { ...this.#snapshot };
  }

  hasRecoveryConfirmation(): boolean {
    return (
      this.#snapshot.recoveryHeartbeatCount >=
      this.#snapshot.requiredRecoveryHeartbeats
    );
  }

  isGateClosed(): boolean {
    return (
      this.#snapshot.state === "queued" ||
      this.#snapshot.state === "running" ||
      this.#snapshot.state === "failed" ||
      (this.#snapshot.state === "completed" &&
        (
          this.#snapshot.recoveryHeartbeatCount <
            this.#snapshot.requiredRecoveryHeartbeats ||
          this.#reservoir.getStats().totalPendingRows > 0
        ))
    );
  }

  queueIfNeeded(): ReplaySessionSnapshot {
    const backlog = this.#reservoir.getStats().totalPendingRows;
    if (backlog === 0) {
      return this.getSnapshot();
    }

    if (this.#snapshot.state === "running" || this.#snapshot.state === "queued") {
      return this.#commit({
        ...this.#snapshot,
        queuedEventCount: Math.max(this.#snapshot.queuedEventCount, backlog),
      });
    }

    if (
      this.#snapshot.state === "failed" &&
      this.#snapshot.nextRetryAt !== null &&
      this.#now() < this.#snapshot.nextRetryAt
    ) {
      return this.#commit({
        ...this.#snapshot,
        queuedEventCount: Math.max(this.#snapshot.queuedEventCount, backlog),
      });
    }

    return this.#commit({
      state: "queued",
      targetPath: "dedupe_then_order",
      queuedEventCount: backlog,
      deliveredEventCount: 0,
      startedAt: null,
      endedAt: null,
      lastError: null,
      nextRetryAt: null,
      consecutiveFailureCount: this.#snapshot.state === "failed"
        ? this.#snapshot.consecutiveFailureCount
        : 0,
      recoveryHeartbeatCount: 0,
      requiredRecoveryHeartbeats: this.#config.healthConfirmationHeartbeats,
    });
  }

  start(): ReplaySessionSnapshot {
    const backlog = this.#reservoir.getStats().totalPendingRows;
    if (backlog === 0) {
      return this.resetToIdle();
    }

    if (this.#snapshot.state === "running") {
      return this.getSnapshot();
    }

    if (this.#snapshot.state !== "queued" && this.#snapshot.state !== "failed") {
      throw new Error(
        `Cannot start replay from state '${this.#snapshot.state}'. Queue replay first.`,
      );
    }

    return this.#commit({
      state: "running",
      targetPath: "dedupe_then_order",
      queuedEventCount: backlog,
      deliveredEventCount: 0,
      startedAt: this.#now(),
      endedAt: null,
      lastError: null,
      nextRetryAt: null,
      recoveryHeartbeatCount: 0,
      requiredRecoveryHeartbeats: this.#config.healthConfirmationHeartbeats,
      consecutiveFailureCount: this.#snapshot.state === "failed"
        ? this.#snapshot.consecutiveFailureCount
        : 0,
    });
  }

  claimNextBatch(limit: number): ReplayBatch {
    if (this.#snapshot.state === "queued") {
      this.start();
    }

    if (this.#snapshot.state !== "running") {
      throw new Error(
        `Cannot claim replay batch while replay is '${this.#snapshot.state}'.`,
      );
    }

    this.#reservoir.reclaimStaleReplayRows(this.#config.retryBackoffMs);
    const entries = this.#reservoir.claimReplayBatch(limit);
    if (entries.length > 0) {
      this.#publishLifecycle?.({
        type: "replayBatchClaimed",
        occurredAtMs: this.#lifecycleNow().toString(),
        rowIds: entries.map((entry) => entry.rowId),
        count: entries.length,
      });
    }

    if (entries.length === 0) {
      const remainingRows = this.#reservoir.getStats().totalPendingRows;
      if (remainingRows === 0) {
        return {
          session: this.complete(),
          entries: [],
          isDrainComplete: true,
        };
      }
    }

    return {
      session: this.getSnapshot(),
      entries,
      isDrainComplete: false,
    };
  }

  acknowledgeBatch(rowIds: ReadonlyArray<number>): ReplaySessionSnapshot {
    const deliveredNow = this.#reservoir.markReplayBatchDelivered(rowIds);
    const remainingRows = this.#reservoir.getStats().totalPendingRows;
    const deliveredEventCount = this.#snapshot.deliveredEventCount + deliveredNow;

    const nextSnapshot = this.#commit({
      ...this.#snapshot,
      deliveredEventCount,
      queuedEventCount: deliveredEventCount + remainingRows,
    });

    if (remainingRows === 0 && nextSnapshot.state === "running") {
      return this.complete();
    }

    return nextSnapshot;
  }

  fail(error: string, rowIds: ReadonlyArray<number> = []): ReplaySessionSnapshot {
    const now = this.#now();
    const nextRetryAt = now + this.#config.retryBackoffMs;
    this.#reservoir.resetReplayBatchToPending(rowIds, nextRetryAt);
    const snapshot = this.#commit({
      ...this.#snapshot,
      state: "failed",
      endedAt: now,
      lastError: error,
      nextRetryAt,
      consecutiveFailureCount: this.#snapshot.consecutiveFailureCount + 1,
    });
    if (rowIds.length > 0) {
      this.#publishLifecycle?.({
        type: "replayBatchFailed",
        occurredAtMs: this.#lifecycleNow().toString(),
        rowIds: [...new Set(rowIds)],
        count: new Set(rowIds).size,
        reasonCode: "REPLAY_DELIVERY_FAILED",
      });
    }
    return snapshot;
  }

  abort(reason: string, rowIds: ReadonlyArray<number> = []): ReplaySessionSnapshot {
    this.#reservoir.resetReplayBatchToPending(rowIds);
    return this.#commit({
      ...this.#snapshot,
      state: "aborted",
      endedAt: this.#now(),
      lastError: reason,
      nextRetryAt: null,
    });
  }

  complete(): ReplaySessionSnapshot {
    return this.#commit({
      ...this.#snapshot,
      state: "completed",
      queuedEventCount: this.#snapshot.deliveredEventCount,
      endedAt: this.#now(),
      lastError: null,
      nextRetryAt: null,
      recoveryHeartbeatCount: 0,
    });
  }

  observeRecoveryHeartbeat(
    component: MonitorComponent,
    state: MonitorHealthState,
    allHealthy: boolean,
  ): ReplaySessionSnapshot {
    if (component === "transport") {
      return this.getSnapshot();
    }

    if (this.#snapshot.state === "running") {
      return this.getSnapshot();
    }

    if (state !== "online" || !allHealthy) {
      return this.#commit({
        ...this.#snapshot,
        recoveryHeartbeatCount: 0,
      });
    }

    const recoveryHeartbeatCount = Math.min(
      this.#snapshot.recoveryHeartbeatCount + 1,
      this.#config.healthConfirmationHeartbeats,
    );
    const nextSnapshot = this.#commit({
      ...this.#snapshot,
      recoveryHeartbeatCount,
    });

    if (
      this.#snapshot.state === "completed" &&
      recoveryHeartbeatCount >= this.#config.healthConfirmationHeartbeats &&
      this.#reservoir.getStats().totalPendingRows === 0
    ) {
      return this.resetToIdle();
    }

    return nextSnapshot;
  }

  resetToIdle(): ReplaySessionSnapshot {
    return this.#commit(createSnapshot(this.#config.healthConfirmationHeartbeats));
  }

  #commit(snapshot: ReplaySessionSnapshot): ReplaySessionSnapshot {
    const previous = this.#snapshot;
    if (sameReplaySnapshot(previous, snapshot)) {
      return this.getSnapshot();
    }
    this.#reservoir.recordReplaySnapshot(snapshot);
    this.#snapshot = { ...snapshot };
    if (previous.state !== snapshot.state) {
      this.#publishLifecycle?.({
        type: "replayStateChanged",
        occurredAtMs: this.#lifecycleNow().toString(),
        previousState: previous.state,
        state: snapshot.state,
        queuedEventCount: snapshot.queuedEventCount,
        deliveredEventCount: snapshot.deliveredEventCount,
        nextRetryAtMs: snapshot.nextRetryAt?.toString() ?? null,
      });
    }
    return this.getSnapshot();
  }

  #lifecycleNow(): bigint {
    try {
      return this.#now();
    } catch {
      return BigInt(Date.now());
    }
  }
}

function sameReplaySnapshot(
  left: ReplaySessionSnapshot,
  right: ReplaySessionSnapshot,
): boolean {
  return (
    left.state === right.state &&
    left.targetPath === right.targetPath &&
    left.queuedEventCount === right.queuedEventCount &&
    left.deliveredEventCount === right.deliveredEventCount &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.lastError === right.lastError &&
    left.nextRetryAt === right.nextRetryAt &&
    left.consecutiveFailureCount === right.consecutiveFailureCount &&
    left.recoveryHeartbeatCount === right.recoveryHeartbeatCount &&
    left.requiredRecoveryHeartbeats === right.requiredRecoveryHeartbeats
  );
}

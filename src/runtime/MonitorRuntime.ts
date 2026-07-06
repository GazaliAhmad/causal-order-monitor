import {
  createDefaultMonitorConfig,
  type MonitorConfig,
} from "../types/config.js";
import { HealthTracker } from "../health/HealthTracker.js";
import { DeliveryRouter } from "../routing/DeliveryRouter.js";
import { ReplayCoordinator } from "../replay/ReplayCoordinator.js";
import { SQLiteReservoir } from "../storage/SQLiteReservoir.js";
import { ThrottleController } from "../throttle/ThrottleController.js";
import type {
  MonitorComponent,
  MonitorIngressDecision,
  MonitorHealthUpdate,
  MonitorIngressEvent,
  MonitorRoutingMode,
  MonitorThrottleTier,
} from "../types/events.js";
import type {
  MonitorSnapshot,
  ReplaySessionSnapshot,
  ReservoirStats,
} from "../types/snapshots.js";

export class MonitorRuntime {
  readonly #config: MonitorConfig;
  readonly #now: () => bigint;
  readonly #healthTracker: HealthTracker;
  readonly #reservoir: SQLiteReservoir;
  readonly #router: DeliveryRouter;
  readonly #replay: ReplayCoordinator;
  #throttleTier: MonitorThrottleTier;

  constructor(config: Partial<MonitorConfig> = {}) {
    const defaults = createDefaultMonitorConfig();
    this.#config = {
      ...defaults,
      ...config,
      reservoir: {
        ...defaults.reservoir,
        ...config.reservoir,
      },
      transport: {
        ...defaults.transport,
        ...config.transport,
      },
      health: {
        transport: {
          ...defaults.health.transport,
          ...config.health?.transport,
        },
        dedupe: {
          ...defaults.health.dedupe,
          ...config.health?.dedupe,
        },
        causalOrder: {
          ...defaults.health.causalOrder,
          ...config.health?.causalOrder,
        },
      },
      throttle: {
        ...defaults.throttle,
        ...config.throttle,
        open: {
          ...defaults.throttle.open,
          ...config.throttle?.open,
        },
        slow: {
          ...defaults.throttle.slow,
          ...config.throttle?.slow,
        },
        verySlow: {
          ...defaults.throttle.verySlow,
          ...config.throttle?.verySlow,
        },
        paused: {
          ...defaults.throttle.paused,
          ...config.throttle?.paused,
        },
      },
      replay: {
        ...defaults.replay,
        ...config.replay,
      },
      now: config.now ?? defaults.now,
    };

    this.#now = this.#config.now ?? defaults.now;
    this.#healthTracker = new HealthTracker(this.#config.health, this.#now);
    this.#reservoir = new SQLiteReservoir(this.#config.reservoir, this.#now);
    this.#router = new DeliveryRouter(
      new ThrottleController(this.#config.throttle),
    );
    this.#replay = new ReplayCoordinator(
      this.#config.replay,
      this.#reservoir,
      this.#now,
    );
    this.#throttleTier = this.#config.throttle.defaultTier;
  }

  getConfig(): Readonly<MonitorConfig> {
    return this.#config;
  }

  getSnapshot(): MonitorSnapshot {
    return {
      generatedAt: this.#now(),
      routingMode: this.#deriveRoutingMode(),
      throttleTier: this.#throttleTier,
      components: this.getHealthSnapshot(),
      reservoir: this.getReservoirStats(),
      replay: this.getReplaySnapshot(),
    };
  }

  getHealthSnapshot() {
    return this.#healthTracker.getSnapshot();
  }

  getReservoirStats(): ReservoirStats {
    return this.#reservoir.getStats();
  }

  getReplaySnapshot(): ReplaySessionSnapshot {
    return this.#replay.getSnapshot();
  }

  getIngressDecision(): MonitorIngressDecision {
    const decision = this.#router.decideIngress(
      this.#deriveRoutingMode(),
      this.getReservoirStats(),
    );
    const gatedDecision =
      this.#config.replay.pauseLiveFlowDuringReplay && this.#replay.isGateClosed()
        ? {
            ...decision,
            action: "buffer_only" as const,
            reason: `${decision.reason}; replay gate holding live flow`,
          }
        : decision;
    this.#throttleTier = gatedDecision.throttleTier;
    return gatedDecision;
  }

  updateComponentHealth(
    component: MonitorComponent,
    update: MonitorHealthUpdate,
  ) {
    const snapshot = this.#healthTracker.updateComponentHealth(component, update);
    this.#reservoir.recordHealthTransition(snapshot);

    if (component === "dedupe" && snapshot.state === "offline") {
      this.#throttleTier = "slow";
    }

    if (component === "causal-order" && snapshot.state === "offline") {
      this.#throttleTier = "paused";
    }

    if (
      component === "transport" &&
      snapshot.state === "offline" &&
      this.getReservoirStats().totalPendingRows === 0
    ) {
      this.#throttleTier = "paused";
    }

    const components = this.#healthTracker.getSnapshot();
    if (
      components.transport.state === "online" &&
      components.dedupe.state === "online" &&
      components["causal-order"].state === "online"
    ) {
      this.#throttleTier = this.#config.throttle.defaultTier;
    }

    this.#reconcileReplayQueue();

    return snapshot;
  }

  observeHeartbeat(
    component: MonitorComponent,
    observedAt = this.#now(),
    details: Record<string, unknown> = {},
  ) {
    const snapshot = this.#healthTracker.observeHeartbeat(
      component,
      observedAt,
      details,
    );
    this.#reservoir.recordHealthTransition(snapshot);
    this.#replay.observeRecoveryHeartbeat(
      component,
      snapshot.state,
      this.#areReplayTargetsHealthy(),
    );
    this.#reconcileReplayQueue();
    return snapshot;
  }

  setThrottleTier(tier: MonitorThrottleTier): MonitorThrottleTier {
    this.#throttleTier = tier;
    return this.#throttleTier;
  }

  queueReplay(): ReplaySessionSnapshot {
    return this.#replay.queueIfNeeded();
  }

  startReplay(): ReplaySessionSnapshot {
    if (!this.#areReplayTargetsHealthy()) {
      throw new Error(
        "Cannot start replay until both dedupe and causal-order are online.",
      );
    }

    this.#replay.queueIfNeeded();
    return this.#replay.start();
  }

  claimReplayBatch(limit = this.#config.throttle.verySlow.batchSize) {
    if (!this.#areReplayTargetsHealthy()) {
      throw new Error(
        "Cannot claim replay batch until both dedupe and causal-order are online.",
      );
    }

    this.#replay.queueIfNeeded();
    return this.#replay.claimNextBatch(limit);
  }

  acknowledgeReplayBatch(rowIds: ReadonlyArray<number>): ReplaySessionSnapshot {
    return this.#replay.acknowledgeBatch(rowIds);
  }

  acknowledgeIngressDelivery(rowIds: ReadonlyArray<number>): number {
    return this.#reservoir.markIngressRowsDelivered(rowIds);
  }

  failReplay(error: string, rowIds: ReadonlyArray<number> = []) {
    return this.#replay.fail(error, rowIds);
  }

  abortReplay(reason: string, rowIds: ReadonlyArray<number> = []) {
    return this.#replay.abort(reason, rowIds);
  }

  ingestTransportEvent(
    event: MonitorIngressEvent,
    sourceStreamId?: string | null,
  ): { rowId: number; decision: MonitorIngressDecision } {
    const decision = this.getIngressDecision();
    const rowId = this.#reservoir.appendIngressEvent(event, {
      sourcePath: "transport_normalized_stream",
      sourceStreamId,
      deliveryMode: decision.deliveryMode,
      fullOutageActive: this.#isFullOutageActive(),
    });
    return { rowId, decision };
  }

  observeDedupeEvent(
    event: MonitorIngressEvent,
    sourceStreamId?: string | null,
  ): number {
    return this.#reservoir.appendIngressEvent(event, {
      sourcePath: "deduped_observation",
      sourceStreamId,
      deliveryMode: "normal",
      replayState: "delivered",
      fullOutageActive: false,
    });
  }

  pruneReservoir(): { markedDeadLetter: number; deletedRows: number } {
    return this.#reservoir.pruneExpired(this.#isFullOutageActive());
  }

  refreshHealthStates(at = this.#now()) {
    const before = this.#healthTracker.getSnapshot();
    const after = this.#healthTracker.refreshStates(at);

    for (const component of ["transport", "dedupe", "causal-order"] as const) {
      if (before[component].state !== after[component].state) {
        this.#reservoir.recordHealthTransition(after[component]);
      }
    }

    this.#reconcileReplayQueue();

    return after;
  }

  close(): void {
    this.#reservoir.close();
  }

  #deriveRoutingMode(): MonitorRoutingMode {
    const components = this.#healthTracker.getSnapshot();
    const transport = components.transport.state;
    const dedupe = components.dedupe.state;
    const causalOrder = components["causal-order"].state;

    if (this.#replay.isGateClosed()) {
      return "replay_through_dedupe";
    }

    if (dedupe === "offline" && causalOrder === "offline") {
      return "full_outage_buffer";
    }

    if (causalOrder === "offline") {
      return "order_buffer_only";
    }

    if (dedupe === "offline") {
      return "dedupe_bypass_throttled";
    }

    if (transport === "offline" && this.getReservoirStats().totalPendingRows > 0) {
      return "order_buffer_only";
    }

    return "normal";
  }

  #isFullOutageActive(): boolean {
    const components = this.#healthTracker.getSnapshot();
    return (
      components.dedupe.state === "offline" &&
      components["causal-order"].state === "offline"
    );
  }

  #areReplayTargetsHealthy(): boolean {
    const components = this.#healthTracker.getSnapshot();
    return (
      components.dedupe.state === "online" &&
      components["causal-order"].state === "online"
    );
  }

  #reconcileReplayQueue(): void {
    const backlog = this.getReservoirStats().totalPendingRows;
    if (backlog === 0) {
      return;
    }

    if (this.#areReplayTargetsHealthy()) {
      this.#replay.queueIfNeeded();
    }
  }
}

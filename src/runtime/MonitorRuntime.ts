import {
  createDefaultMonitorConfig,
  type MonitorConfig,
} from "../types/config.js";
import { HealthTracker } from "../health/HealthTracker.js";
import {
  inspectMonitorSnapshot,
  inspectMonitorSnapshotV1,
} from "../inspect/inspectMonitorSnapshot.js";
import {
  MonitorAdmissionRefusedError,
  MonitorClosedError,
} from "../boundary.js";
import { DeliveryRouter } from "../routing/DeliveryRouter.js";
import { ReplayCoordinator } from "../replay/ReplayCoordinator.js";
import {
  SQLiteReservoir,
  type ReservoirLifecycleStats,
  type WalCheckpointMode,
  type WalCheckpointResult,
} from "../storage/SQLiteReservoir.js";
import type { MonitorSchemaInfo } from "../storage/schema.js";
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
  InspectedMonitorSnapshot,
  MonitorOperatorSnapshotV1,
  MonitorSnapshot,
  ReplaySessionSnapshot,
  ReservoirStats,
} from "../types/snapshots.js";

type ReplayOrchestrationOwner = "manual" | "adapter";

export class ReplayOwnershipError extends Error {
  readonly code = "ERR_MONITOR_REPLAY_OWNERSHIP";
  readonly attemptedAction: string;
  readonly actualOwner: ReplayOrchestrationOwner;
  readonly requestedOwner: ReplayOrchestrationOwner;

  constructor(
    attemptedAction: string,
    actualOwner: ReplayOrchestrationOwner,
    requestedOwner: ReplayOrchestrationOwner,
    guidance: string,
  ) {
    super(
      `Cannot ${attemptedAction} because this runtime is already bound to '${actualOwner}' replay orchestration. ${guidance}`,
    );
    this.name = "ReplayOwnershipError";
    this.attemptedAction = attemptedAction;
    this.actualOwner = actualOwner;
    this.requestedOwner = requestedOwner;
  }
}

export class MonitorRuntime {
  readonly #config: MonitorConfig;
  readonly #now: () => bigint;
  readonly #healthTracker: HealthTracker;
  readonly #reservoir: SQLiteReservoir;
  readonly #router: DeliveryRouter;
  readonly #replay: ReplayCoordinator;
  #throttleTier: MonitorThrottleTier;
  #recoveryReplayNeeded: boolean;
  #observedRecoveryTransition: boolean;
  #startupHealthReady: boolean;
  readonly #startupHealthEvidence = new Set<MonitorComponent>();
  #replayOwner: ReplayOrchestrationOwner | null;
  #closed = false;

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
      startup: {
        ...defaults.startup,
        ...config.startup,
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
    this.#recoveryReplayNeeded = this.#reservoir.getPendingRowCount() > 0;
    this.#observedRecoveryTransition = this.#recoveryReplayNeeded;
    this.#startupHealthReady = this.#config.startup.healthPolicy === "optimistic";
    this.#replayOwner = null;
  }

  getConfig(): Readonly<MonitorConfig> {
    return this.#config;
  }

  getSnapshot(): MonitorSnapshot {
    this.#assertOpen("read the monitor snapshot");
    const reservoir = this.getReservoirStats();
    return {
      generatedAt: this.#now(),
      routingMode: this.#deriveRoutingMode(reservoir.totalPendingRows),
      throttleTier: this.#throttleTier,
      components: this.getHealthSnapshot(),
      reservoir,
      replay: this.getReplaySnapshot(),
    };
  }

  getInspectedSnapshot(): InspectedMonitorSnapshot {
    return inspectMonitorSnapshot(this.getSnapshot());
  }

  getOperatorSnapshot(): MonitorOperatorSnapshotV1 {
    return inspectMonitorSnapshotV1(
      this.getSnapshot(),
      this.#reservoir.getStorageSnapshot(),
    );
  }

  getHealthSnapshot() {
    return this.#healthTracker.getSnapshot();
  }

  getReservoirStats(): ReservoirStats {
    this.#assertOpen("read reservoir statistics");
    return this.#reservoir.getStats();
  }

  getSchemaInfo(): Readonly<MonitorSchemaInfo> {
    return this.#reservoir.getSchemaInfo();
  }

  getReservoirLifecycleStats(): ReservoirLifecycleStats {
    this.#assertOpen("read reservoir lifecycle statistics");
    return this.#reservoir.getLifecycleStats();
  }

  checkpointReservoirWal(
    mode: WalCheckpointMode = "passive",
  ): WalCheckpointResult {
    this.#assertOpen("checkpoint the reservoir WAL");
    return this.#reservoir.checkpointWal(mode);
  }

  getReplaySnapshot(): ReplaySessionSnapshot {
    return this.#replay.getSnapshot();
  }

  getIngressDecision(): MonitorIngressDecision {
    this.#assertOpen("derive an ingress decision");
    const totalPendingRows = this.#reservoir.getPendingRowCount();
    const decision = this.#router.decideIngress(
      this.#deriveRoutingMode(totalPendingRows),
      { totalPendingRows },
    );
    const gatedDecision =
      this.#config.replay.pauseLiveFlowDuringReplay &&
      (
        this.#replay.isGateClosed() ||
        this.#shouldHoldLiveFlowForRecoveryConfirmation()
      )
        ? {
            ...decision,
            action: "buffer_only" as const,
            reason: `${
              decision.reason
            }; ${
              this.#replay.isGateClosed()
                ? "replay gate holding live flow"
                : "recovery confirmation holding live flow before replay start"
            }`,
          }
        : decision;
    const startupGatedDecision =
      this.#config.startup.healthPolicy === "conservative" &&
      !this.#startupHealthReady
        ? {
            ...gatedDecision,
            action: "buffer_only" as const,
            reason: `${gatedDecision.reason}; conservative startup awaiting health evidence`,
          }
        : gatedDecision;
    this.#throttleTier = startupGatedDecision.throttleTier;
    return startupGatedDecision;
  }

  updateComponentHealth(
    component: MonitorComponent,
    update: MonitorHealthUpdate,
  ) {
    this.#assertOpen("update component health");
    const previous = this.#healthTracker.getComponentSnapshot(component);
    const snapshot = this.#healthTracker.updateComponentHealth(component, update);
    this.#recordStartupHealthEvidence(component, snapshot.state);
    this.#reservoir.recordHealthTransition(snapshot);

    if (
      component !== "transport" &&
      previous.state !== snapshot.state
    ) {
      this.#observedRecoveryTransition = true;
    }

    if (component === "dedupe" && snapshot.state === "offline") {
      this.#throttleTier = "slow";
    }

    if (component === "causal-order" && snapshot.state === "offline") {
      this.#throttleTier = "paused";
    }

    if (
      component !== "transport" &&
      snapshot.state === "offline"
    ) {
      this.#recoveryReplayNeeded = true;
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

    if (component !== "transport") {
      this.#replay.observeRecoveryHeartbeat(
        component,
        snapshot.state,
        this.#areReplayTargetsHealthy(),
      );
    }

    this.#reconcileReplayQueue();

    return snapshot;
  }

  observeHeartbeat(
    component: MonitorComponent,
    observedAt = this.#now(),
    details: Record<string, unknown> = {},
  ) {
    this.#assertOpen("observe a component heartbeat");
    const snapshot = this.#healthTracker.observeHeartbeat(
      component,
      observedAt,
      details,
    );
    this.#recordStartupHealthEvidence(component, snapshot.state);
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
    this.#assertOpen("set the throttle tier");
    this.#throttleTier = tier;
    return this.#throttleTier;
  }

  bindReplayOrchestrationOwner(owner: ReplayOrchestrationOwner): ReplayOrchestrationOwner {
    this.#assertOpen("bind replay orchestration ownership");
    if (this.#replayOwner !== null && this.#replayOwner !== owner) {
      throw new ReplayOwnershipError(
        "bind replay orchestration ownership",
        this.#replayOwner,
        owner,
        "Use a fresh MonitorRuntime when switching between manual replay control and adapter-managed replay control.",
      );
    }

    this.#replayOwner = owner;
    return this.#replayOwner;
  }

  queueReplay(): ReplaySessionSnapshot {
    return this.#queueReplayForOwner("manual");
  }

  queueManagedReplay(): ReplaySessionSnapshot {
    return this.#queueReplayForOwner("adapter");
  }

  startReplay(): ReplaySessionSnapshot {
    this.#assertOpen("start replay");
    this.#assertReplayOwnership(
      "manual",
      "start replay manually",
      "Use TransportMonitorAdapter replay helpers instead of direct MonitorRuntime replay commands on an adapter-managed runtime.",
    );

    return this.#startReplayInternal();
  }

  claimManagedReplayBatch(limit = this.#config.throttle.verySlow.batchSize) {
    this.#assertOpen("claim an adapter-managed replay batch");
    this.#assertReplayOwnership(
      "adapter",
      "claim an adapter-managed replay batch",
      "Use MonitorRuntime replay commands directly only on runtimes that are not adapter-managed.",
    );

    return this.#claimReplayBatchInternal(limit);
  }

  acknowledgeManagedReplayBatch(
    rowIds: ReadonlyArray<number>,
  ): ReplaySessionSnapshot {
    this.#assertOpen("acknowledge an adapter-managed replay batch");
    this.#assertReplayOwnership(
      "adapter",
      "acknowledge an adapter-managed replay batch",
      "Use MonitorRuntime replay commands directly only on runtimes that are not adapter-managed.",
    );

    return this.#replay.acknowledgeBatch(rowIds);
  }

  failManagedReplay(
    error: string,
    rowIds: ReadonlyArray<number> = [],
  ) {
    this.#assertOpen("fail an adapter-managed replay session");
    this.#assertReplayOwnership(
      "adapter",
      "fail an adapter-managed replay session",
      "Use MonitorRuntime replay commands directly only on runtimes that are not adapter-managed.",
    );

    return this.#replay.fail(error, rowIds);
  }

  abortManagedReplay(
    reason: string,
    rowIds: ReadonlyArray<number> = [],
  ) {
    this.#assertOpen("abort an adapter-managed replay session");
    this.#assertReplayOwnership(
      "adapter",
      "abort an adapter-managed replay session",
      "Use MonitorRuntime replay commands directly only on runtimes that are not adapter-managed.",
    );

    return this.#replay.abort(reason, rowIds);
  }

  claimReplayBatch(limit = this.#config.throttle.verySlow.batchSize) {
    this.#assertOpen("claim a manual replay batch");
    this.#assertReplayOwnership(
      "manual",
      "claim a manual replay batch",
      "Use TransportMonitorAdapter replay helpers instead of direct MonitorRuntime replay commands on an adapter-managed runtime.",
    );

    return this.#claimReplayBatchInternal(limit);
  }

  acknowledgeReplayBatch(rowIds: ReadonlyArray<number>): ReplaySessionSnapshot {
    this.#assertOpen("acknowledge a manual replay batch");
    this.#assertReplayOwnership(
      "manual",
      "acknowledge a manual replay batch",
      "Use TransportMonitorAdapter replay helpers instead of direct MonitorRuntime replay commands on an adapter-managed runtime.",
    );

    return this.#replay.acknowledgeBatch(rowIds);
  }

  acknowledgeIngressDelivery(rowIds: ReadonlyArray<number>): number {
    this.#assertOpen("acknowledge ingress delivery");
    return this.#reservoir.markIngressRowsDelivered(rowIds);
  }

  failReplay(error: string, rowIds: ReadonlyArray<number> = []) {
    this.#assertOpen("fail a manual replay session");
    this.#assertReplayOwnership(
      "manual",
      "fail a manual replay session",
      "Use TransportMonitorAdapter replay helpers instead of direct MonitorRuntime replay commands on an adapter-managed runtime.",
    );

    return this.#replay.fail(error, rowIds);
  }

  abortReplay(reason: string, rowIds: ReadonlyArray<number> = []) {
    this.#assertOpen("abort a manual replay session");
    this.#assertReplayOwnership(
      "manual",
      "abort a manual replay session",
      "Use TransportMonitorAdapter replay helpers instead of direct MonitorRuntime replay commands on an adapter-managed runtime.",
    );

    return this.#replay.abort(reason, rowIds);
  }

  ingestTransportEvent(
    event: MonitorIngressEvent,
    sourceStreamId?: string | null,
  ): { rowId: number; decision: MonitorIngressDecision } {
    this.#assertOpen("ingest a transport event");
    const decision = this.getIngressDecision();
    if (decision.action === "pause") {
      throw new MonitorAdmissionRefusedError(decision);
    }
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
    this.#assertOpen("observe a dedupe event");
    return this.#reservoir.appendIngressEvent(event, {
      sourcePath: "deduped_observation",
      sourceStreamId,
      deliveryMode: "normal",
      replayState: "delivered",
      fullOutageActive: false,
    });
  }

  pruneReservoir(): { markedDeadLetter: number; deletedRows: number } {
    this.#assertOpen("prune the reservoir");
    this.#reservoir.reclaimStaleReplayRows(this.#config.replay.retryBackoffMs);
    return this.#reservoir.pruneExpired(this.#isFullOutageActive());
  }

  refreshHealthStates(at = this.#now()) {
    this.#assertOpen("refresh health states");
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

  needsRecoveryReplay(): boolean {
    return this.#recoveryReplayNeeded;
  }

  hasObservedRecoveryTransition(): boolean {
    return this.#observedRecoveryTransition;
  }

  isReplayRecoveryConfirmed(): boolean {
    return this.#replay.hasRecoveryConfirmation();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#reservoir.close();
    } finally {
      this.#closed = true;
    }
  }

  #queueReplayForOwner(owner: ReplayOrchestrationOwner): ReplaySessionSnapshot {
    this.#assertOpen("queue replay");
    this.#assertReplayOwnership(
      owner,
      owner === "adapter" ? "queue adapter-managed replay" : "queue replay manually",
      owner === "adapter"
        ? "Use MonitorRuntime replay commands directly only on runtimes that are not adapter-managed."
        : "Use TransportMonitorAdapter replay helpers instead of direct MonitorRuntime replay commands on an adapter-managed runtime.",
    );
    return this.#replay.queueIfNeeded();
  }

  #startReplayInternal(): ReplaySessionSnapshot {
    if (!this.#areReplayTargetsHealthy()) {
      throw new Error(
        "Cannot start replay until both dedupe and causal-order are online.",
      );
    }

    this.#replay.queueIfNeeded();
    return this.#replay.start();
  }

  #claimReplayBatchInternal(limit = this.#config.throttle.verySlow.batchSize) {
    this.#assertOpen("claim a replay batch");
    if (!this.#areReplayTargetsHealthy()) {
      throw new Error(
        "Cannot claim replay batch until both dedupe and causal-order are online.",
      );
    }

    this.#replay.queueIfNeeded();
    return this.#replay.claimNextBatch(limit);
  }

  #deriveRoutingMode(
    totalPendingRows = this.#reservoir.getPendingRowCount(),
  ): MonitorRoutingMode {
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

    if (transport === "offline" && totalPendingRows > 0) {
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
    const reservoir = this.getReservoirStats();
    if (reservoir.totalPendingRows === 0) {
      this.#resetRecoveryReplayIfDrained();
      return;
    }

    this.#resetRecoveryReplayIfDrained();
  }

  #hasReplayEligibleBacklog(reservoir: ReservoirStats): boolean {
    return Object.entries(reservoir.pendingRowsByDeliveryMode).some(
      ([deliveryMode, count]) =>
        deliveryMode !== "normal" &&
        deliveryMode !== "dedupe_bypass" &&
        Number(count ?? 0) > 0,
    );
  }

  #resetRecoveryReplayIfDrained(): void {
    if (
      this.#areReplayTargetsHealthy() &&
      this.#replay.getSnapshot().state === "idle" &&
      this.getReservoirStats().totalPendingRows === 0
    ) {
      this.#recoveryReplayNeeded = false;
    }
  }

  #shouldHoldLiveFlowForRecoveryConfirmation(): boolean {
    if (
      !this.#areReplayTargetsHealthy() ||
      !this.#recoveryReplayNeeded ||
      !this.#observedRecoveryTransition ||
      this.#replay.hasRecoveryConfirmation()
    ) {
      return false;
    }

    return this.#hasReplayEligibleBacklog(this.getReservoirStats());
  }

  #recordStartupHealthEvidence(
    component: MonitorComponent,
    state: MonitorHealthUpdate["state"],
  ): void {
    if (this.#config.startup.healthPolicy !== "conservative") return;
    if (state === "online") this.#startupHealthEvidence.add(component);
    if (this.#startupHealthEvidence.size === 3) this.#startupHealthReady = true;
  }

  #assertReplayOwnership(
    owner: ReplayOrchestrationOwner,
    attemptedAction: string,
    mismatchGuidance: string,
  ): void {
    if (this.#replayOwner === null) {
      this.#replayOwner = owner;
      return;
    }

    if (this.#replayOwner !== owner) {
      throw new ReplayOwnershipError(
        attemptedAction,
        this.#replayOwner,
        owner,
        mismatchGuidance,
      );
    }
  }

  #assertOpen(operation: string): void {
    if (this.#closed) {
      throw new MonitorClosedError(operation);
    }
  }
}

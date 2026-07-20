import { MonitorRuntime } from "../runtime/MonitorRuntime.js";
import { LifecycleDispatcher } from "../lifecycle/LifecycleDispatcher.js";
import {
  loadMonitorConfigFile,
  resolveMonitorConfigFromEnvironment,
  type MonitorConfigEnvironmentOptions,
  type MonitorConfigOverride,
} from "../config.js";
import type {
  MonitorComponent,
  MonitorDeliveryMode,
  MonitorIngressDecision,
  MonitorIngressEvent,
} from "../types/events.js";
import type {
  InspectedMonitorSnapshot,
  MonitorCapacityFacet,
  MonitorOperatorSnapshotV1,
  MonitorSnapshot,
  ReplaySessionSnapshot,
} from "../types/snapshots.js";
import type {
  MonitorLifecycleEventName,
  MonitorLifecycleEvents,
  MonitorLifecycleFacet,
} from "../types/lifecycle.js";
import {
  deriveMonitorAdmissionDecision,
  type MonitorAdmissionDecision,
  MonitorIndeterminateOutcomeError,
} from "../boundary.js";

export interface MonitorAdapterForwardContext {
  rowId: number;
  sourceStreamId: string | null;
  deliveryMode: MonitorDeliveryMode;
  replay: boolean;
}

export interface MonitorAdapterHandlers {
  deliverToDedupe: (
    event: MonitorIngressEvent,
    context: MonitorAdapterForwardContext,
  ) => Promise<void> | void;
  deliverToOrder: (
    event: MonitorIngressEvent,
    context: MonitorAdapterForwardContext,
  ) => Promise<void> | void;
  onBuffered?: (
    event: MonitorIngressEvent,
    decision: MonitorIngressDecision,
    rowId: number,
  ) => Promise<void> | void;
  onDecision?: (
    event: MonitorIngressEvent,
    decision: MonitorIngressDecision,
    rowId: number,
  ) => Promise<void> | void;
  onReplayStateChange?: (
    snapshot: ReplaySessionSnapshot,
  ) => Promise<void> | void;
}

export interface MonitorIngestResult {
  rowId: number;
  decision: MonitorIngressDecision;
  admission: MonitorAdmissionDecision;
  forwardedTo: "dedupe" | "causal-order" | "buffer";
}

export interface ReplayPumpResult {
  snapshot: ReplaySessionSnapshot;
  claimedCount: number;
  deliveredCount: number;
  completed: boolean;
}

type MonitorLifecycleObservation = {
  [K in MonitorLifecycleEventName]: Omit<MonitorLifecycleEvents[K], "occurredAtMs">;
}[MonitorLifecycleEventName];

export class TransportMonitorAdapter {
  readonly capacity: MonitorCapacityFacet;
  readonly lifecycle: MonitorLifecycleFacet;
  readonly #runtime: MonitorRuntime;
  readonly #handlers: MonitorAdapterHandlers;
  #activeReplayOperation: Promise<ReplayPumpResult | null> | null = null;

  constructor(
    handlers: MonitorAdapterHandlers,
    config: MonitorConfigOverride = {},
  ) {
    this.#runtime = new MonitorRuntime(config);
    this.capacity = this.#runtime.capacity;
    this.lifecycle = this.#runtime.lifecycle;
    this.#runtime.bindReplayOrchestrationOwner("adapter");
    this.#handlers = handlers;
  }

  getRuntime(): MonitorRuntime {
    return this.#runtime;
  }

  getSnapshot(): MonitorSnapshot {
    return this.#runtime.getSnapshot();
  }

  getInspectedSnapshot(): InspectedMonitorSnapshot {
    return this.#runtime.getInspectedSnapshot();
  }

  getOperatorSnapshot(): MonitorOperatorSnapshotV1 {
    return this.#runtime.getOperatorSnapshot();
  }

  getReplaySnapshot(): ReplaySessionSnapshot {
    return this.#runtime.getReplaySnapshot();
  }

  updateComponentHealth(
    component: MonitorComponent,
    update: Parameters<MonitorRuntime["updateComponentHealth"]>[1],
  ) {
    const snapshot = this.#runtime.updateComponentHealth(component, update);
    void this.#notifyReplayChange();
    return snapshot;
  }

  observeHeartbeat(
    component: MonitorComponent,
    observedAt?: bigint,
    details?: Record<string, unknown>,
  ) {
    const snapshot = this.#runtime.observeHeartbeat(
      component,
      observedAt,
      details,
    );
    void this.#notifyReplayChange();
    return snapshot;
  }

  async ingest(
    event: MonitorIngressEvent,
    sourceStreamId?: string | null,
  ): Promise<MonitorIngestResult> {
    const operationStartedAt = this.#now();
    const { rowId, decision } = this.#runtime.ingestTransportEvent(
      event,
      sourceStreamId,
    );
    const admission = deriveMonitorAdmissionDecision(decision);
    let deliveryAttempted = false;
    let deliveryHandlerCompleted = false;
    let deliveryStartedAt = operationStartedAt;
    try {
      await this.#handlers.onDecision?.(event, decision, rowId);

      if (decision.action === "buffer_only" || decision.action === "pause") {
        await this.#handlers.onBuffered?.(event, decision, rowId);
        this.#emitOperationDuration("adapter.ingest", operationStartedAt, "buffered");
        return {
          rowId,
          decision,
          admission,
          forwardedTo: "buffer",
        };
      }

      if (decision.deliveryMode === "dedupe_bypass") {
        deliveryAttempted = true;
        deliveryStartedAt = this.#now();
        this.#emitLifecycleAt(deliveryStartedAt, {
          type: "deliveryAttempted",
          rowId,
          eventId: event.id,
          deliveryMode: decision.deliveryMode,
          replay: false,
        });
        await this.#handlers.deliverToOrder(event, {
          rowId,
          sourceStreamId: sourceStreamId ?? null,
          deliveryMode: decision.deliveryMode,
          replay: false,
        });
        deliveryHandlerCompleted = true;
        this.#emitLifecycle({
          type: "deliveryHandlerCompleted",
          rowId,
          eventId: event.id,
          deliveryMode: decision.deliveryMode,
          replay: false,
          durationMs: this.#durationSince(deliveryStartedAt),
        });
        this.#runtime.acknowledgeIngressDelivery([rowId]);
        this.#emitOperationDuration("adapter.ingest", operationStartedAt, "delivered");
        return {
          rowId,
          decision,
          admission,
          forwardedTo: "causal-order",
        };
      }

      deliveryAttempted = true;
      deliveryStartedAt = this.#now();
      this.#emitLifecycleAt(deliveryStartedAt, {
        type: "deliveryAttempted",
        rowId,
        eventId: event.id,
        deliveryMode: decision.deliveryMode,
        replay: false,
      });
      await this.#handlers.deliverToDedupe(event, {
        rowId,
        sourceStreamId: sourceStreamId ?? null,
        deliveryMode: decision.deliveryMode,
        replay: false,
      });
      deliveryHandlerCompleted = true;
      this.#emitLifecycle({
        type: "deliveryHandlerCompleted",
        rowId,
        eventId: event.id,
        deliveryMode: decision.deliveryMode,
        replay: false,
        durationMs: this.#durationSince(deliveryStartedAt),
      });
      this.#runtime.acknowledgeIngressDelivery([rowId]);
      this.#emitOperationDuration("adapter.ingest", operationStartedAt, "delivered");
      return {
        rowId,
        decision,
        admission,
        forwardedTo: "dedupe",
      };
    } catch (error) {
      if (deliveryAttempted && !deliveryHandlerCompleted) {
        this.#emitLifecycle({
          type: "deliveryFailed",
          rowId,
          eventId: event.id,
          deliveryMode: decision.deliveryMode,
          replay: false,
          durationMs: this.#durationSince(deliveryStartedAt),
          reasonCode: "DELIVERY_HANDLER_REJECTED",
        });
      } else {
        this.#emitLifecycle({
          type: "deliveryIndeterminate",
          rowId,
          eventId: event.id,
          deliveryMode: decision.deliveryMode,
          replay: false,
          reasonCode: deliveryHandlerCompleted
            ? "DELIVERY_ACKNOWLEDGEMENT_UNOBSERVED"
            : "ADAPTER_COMPLETION_UNOBSERVED",
        });
      }
      this.#emitOperationDuration("adapter.ingest", operationStartedAt, "failed");
      throw new MonitorIndeterminateOutcomeError(
        "complete adapter ingress delivery",
        rowId,
        error,
      );
    }
  }

  async pumpReplayBatch(limit?: number): Promise<ReplayPumpResult> {
    if (this.#activeReplayOperation) {
      return this.#activeReplayOperation.then(
        (result) => result ?? this.#emptyReplayPumpResult(),
      );
    }
    return this.#runReplayOperation(() => this.#pumpReplayBatchInternal(limit)).then(
      (result) => result ?? this.#emptyReplayPumpResult(),
    );
  }

  async #pumpReplayBatchInternal(limit?: number): Promise<ReplayPumpResult> {
    const operationStartedAt = this.#now();
    const batch = this.#runtime.claimManagedReplayBatch(limit);
    await this.#notifyReplayChange();

    if (batch.entries.length === 0) {
      await this.#notifyReplayChange();
      this.#emitOperationDuration("adapter.pumpReplayBatch", operationStartedAt, "empty");
      return {
        snapshot: this.#runtime.getReplaySnapshot(),
        claimedCount: 0,
        deliveredCount: 0,
        completed: batch.isDrainComplete,
      };
    }

    const claimedRowIds: number[] = [];
    const handlerCompletedEntries: typeof batch.entries = [];
    let activeEntry: (typeof batch.entries)[number] | null = null;
    let activeEntryStartedAt = operationStartedAt;

    try {
      for (const entry of batch.entries) {
        activeEntry = entry;
        claimedRowIds.push(entry.rowId);
        activeEntryStartedAt = this.#now();
        this.#emitLifecycleAt(activeEntryStartedAt, {
          type: "deliveryAttempted",
          rowId: entry.rowId,
          eventId: entry.event.id,
          deliveryMode: "replay_through_dedupe",
          replay: true,
          attempt: entry.replayAttempts,
        });
        await this.#handlers.deliverToDedupe(entry.event, {
          rowId: entry.rowId,
          sourceStreamId: entry.sourceStreamId,
          deliveryMode: "replay_through_dedupe",
          replay: true,
        });
        handlerCompletedEntries.push(entry);
        this.#emitLifecycle({
          type: "deliveryHandlerCompleted",
          rowId: entry.rowId,
          eventId: entry.event.id,
          deliveryMode: "replay_through_dedupe",
          replay: true,
          attempt: entry.replayAttempts,
          durationMs: this.#durationSince(activeEntryStartedAt),
        });
        activeEntry = null;
      }

      const snapshot = this.#runtime.acknowledgeManagedReplayBatch(claimedRowIds);
      await this.#notifyReplayChange();
      this.#emitOperationDuration("adapter.pumpReplayBatch", operationStartedAt, "completed");
      return {
        snapshot,
        claimedCount: claimedRowIds.length,
        deliveredCount: claimedRowIds.length,
        completed: snapshot.state === "completed" || snapshot.state === "idle",
      };
    } catch (error) {
      if (activeEntry !== null) {
        this.#emitLifecycle({
          type: "deliveryFailed",
          rowId: activeEntry.rowId,
          eventId: activeEntry.event.id,
          deliveryMode: "replay_through_dedupe",
          replay: true,
          attempt: activeEntry.replayAttempts,
          durationMs: this.#durationSince(activeEntryStartedAt),
          reasonCode: "DELIVERY_HANDLER_REJECTED",
        });
      }
      for (const completedEntry of handlerCompletedEntries) {
        this.#emitLifecycle({
          type: "deliveryIndeterminate",
          rowId: completedEntry.rowId,
          eventId: completedEntry.event.id,
          deliveryMode: "replay_through_dedupe",
          replay: true,
          attempt: completedEntry.replayAttempts,
          reasonCode: "REPLAY_BATCH_ACKNOWLEDGEMENT_UNOBSERVED",
        });
      }
      const message =
        error instanceof Error ? error.message : "unknown replay failure";
      const snapshot = this.#runtime.failManagedReplay(message, claimedRowIds);
      await this.#notifyReplayChange();
      this.#emitOperationDuration("adapter.pumpReplayBatch", operationStartedAt, "failed");
      return {
        snapshot,
        claimedCount: claimedRowIds.length,
        deliveredCount: 0,
        completed: false,
      };
    }
  }

  async reconcileRecovery(limit?: number): Promise<ReplayPumpResult | null> {
    if (this.#activeReplayOperation) {
      return this.#activeReplayOperation;
    }
    return this.#runReplayOperation(() => this.#reconcileRecoveryInternal(limit));
  }

  async #reconcileRecoveryInternal(limit?: number): Promise<ReplayPumpResult | null> {
    const snapshot = this.#runtime.getReplaySnapshot();
    const reservoir = this.#runtime.getReservoirStats();
    const backlog = reservoir.totalPendingRows;
    const needsRecoveryReplay = this.#runtime.needsRecoveryReplay();
    const hasObservedRecoveryTransition =
      this.#runtime.hasObservedRecoveryTransition();
    const hasReplayEligibleBacklog = this.#hasReplayEligibleBacklog(
      reservoir.pendingRowsByDeliveryMode,
    );

    if (backlog === 0) {
      return null;
    }

    if (
      snapshot.state === "idle" &&
      (
        !needsRecoveryReplay ||
        !hasObservedRecoveryTransition ||
        !hasReplayEligibleBacklog
      )
    ) {
      return null;
    }

    if (
      snapshot.state === "completed" &&
      !hasReplayEligibleBacklog
    ) {
      return null;
    }

    if (
      (
        snapshot.state === "idle" ||
        snapshot.state === "failed" ||
        snapshot.state === "completed"
      ) &&
      !this.#runtime.isReplayRecoveryConfirmed()
    ) {
      return null;
    }

    if (
      snapshot.state === "idle" ||
      snapshot.state === "failed" ||
      snapshot.state === "completed"
    ) {
      this.#runtime.queueManagedReplay();
      await this.#notifyReplayChange();
    }

    const nextSnapshot = this.#runtime.getReplaySnapshot();
    if (nextSnapshot.state !== "queued" && nextSnapshot.state !== "running") {
      return null;
    }

    return this.#pumpReplayBatchInternal(limit);
  }

  close(): void {
    this.#runtime.close();
  }

  async #notifyReplayChange(): Promise<void> {
    await this.#handlers.onReplayStateChange?.(this.#runtime.getReplaySnapshot());
  }

  #runReplayOperation(
    operation: () => Promise<ReplayPumpResult | null>,
  ): Promise<ReplayPumpResult | null> {
    if (this.#activeReplayOperation) {
      return this.#activeReplayOperation;
    }

    const activeOperation = operation();
    this.#activeReplayOperation = activeOperation;
    void activeOperation.then(
      () => {
        if (this.#activeReplayOperation === activeOperation) {
          this.#activeReplayOperation = null;
        }
      },
      () => {
        if (this.#activeReplayOperation === activeOperation) {
          this.#activeReplayOperation = null;
        }
      },
    );
    return activeOperation;
  }

  #emptyReplayPumpResult(): ReplayPumpResult {
    const snapshot = this.#runtime.getReplaySnapshot();
    return {
      snapshot,
      claimedCount: 0,
      deliveredCount: 0,
      completed: snapshot.state === "completed" || snapshot.state === "idle",
    };
  }

  #hasReplayEligibleBacklog(
    pendingRowsByDeliveryMode: MonitorSnapshot["reservoir"]["pendingRowsByDeliveryMode"],
  ): boolean {
    return Object.entries(pendingRowsByDeliveryMode).some(
      ([deliveryMode, count]) =>
        deliveryMode !== "normal" &&
        deliveryMode !== "dedupe_bypass" &&
        Number(count ?? 0) > 0,
    );
  }

  #now(): bigint {
    try {
      return this.#runtime.getConfig().now?.() ?? BigInt(Date.now());
    } catch {
      return BigInt(Date.now());
    }
  }

  #durationSince(startedAt: bigint): string {
    const endedAt = this.#now();
    return (endedAt >= startedAt ? endedAt - startedAt : 0n).toString();
  }

  #emitLifecycle(event: MonitorLifecycleObservation): void {
    this.#emitLifecycleAt(this.#now(), event);
  }

  #emitLifecycleAt(occurredAt: bigint, event: MonitorLifecycleObservation): void {
    try {
      (this.lifecycle as LifecycleDispatcher).publish({
        ...event,
        occurredAtMs: occurredAt.toString(),
      } as MonitorLifecycleEvents[MonitorLifecycleEventName]);
    } catch {
      // Lifecycle observation is best effort and cannot alter adapter outcomes.
    }
  }

  #emitOperationDuration(operation: string, startedAt: bigint, outcome: string): void {
    const endedAt = this.#now();
    this.#emitLifecycleAt(endedAt, {
      type: "operationDurationObserved",
      operation,
      durationMs: (endedAt >= startedAt ? endedAt - startedAt : 0n).toString(),
      outcome,
    });
  }
}

export function createTransportMonitorAdapterFromFile(
  handlers: MonitorAdapterHandlers,
  configPath?: string,
): TransportMonitorAdapter {
  return new TransportMonitorAdapter(handlers, loadMonitorConfigFile(configPath));
}

export function createTransportMonitorAdapterFromEnvironment(
  handlers: MonitorAdapterHandlers,
  inlineConfig: MonitorConfigOverride = {},
  options: MonitorConfigEnvironmentOptions = {},
): TransportMonitorAdapter {
  return new TransportMonitorAdapter(
    handlers,
    resolveMonitorConfigFromEnvironment(inlineConfig, options),
  );
}

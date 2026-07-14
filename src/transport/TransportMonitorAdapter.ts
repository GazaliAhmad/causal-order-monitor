import { MonitorRuntime } from "../runtime/MonitorRuntime.js";
import type { MonitorConfig } from "../types/config.js";
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
  MonitorOperatorSnapshotV1,
  MonitorSnapshot,
  ReplaySessionSnapshot,
} from "../types/snapshots.js";
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

export class TransportMonitorAdapter {
  readonly #runtime: MonitorRuntime;
  readonly #handlers: MonitorAdapterHandlers;

  constructor(
    handlers: MonitorAdapterHandlers,
    config: Partial<MonitorConfig> = {},
  ) {
    this.#runtime = new MonitorRuntime(config);
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
    const { rowId, decision } = this.#runtime.ingestTransportEvent(
      event,
      sourceStreamId,
    );
    const admission = deriveMonitorAdmissionDecision(decision);
    try {
      await this.#handlers.onDecision?.(event, decision, rowId);

      if (decision.action === "buffer_only" || decision.action === "pause") {
        await this.#handlers.onBuffered?.(event, decision, rowId);
        return {
          rowId,
          decision,
          admission,
          forwardedTo: "buffer",
        };
      }

      if (decision.deliveryMode === "dedupe_bypass") {
        await this.#handlers.deliverToOrder(event, {
          rowId,
          sourceStreamId: sourceStreamId ?? null,
          deliveryMode: decision.deliveryMode,
          replay: false,
        });
        this.#runtime.acknowledgeIngressDelivery([rowId]);
        return {
          rowId,
          decision,
          admission,
          forwardedTo: "causal-order",
        };
      }

      await this.#handlers.deliverToDedupe(event, {
        rowId,
        sourceStreamId: sourceStreamId ?? null,
        deliveryMode: decision.deliveryMode,
        replay: false,
      });
      this.#runtime.acknowledgeIngressDelivery([rowId]);
      return {
        rowId,
        decision,
        admission,
        forwardedTo: "dedupe",
      };
    } catch (error) {
      throw new MonitorIndeterminateOutcomeError(
        "complete adapter ingress delivery",
        rowId,
        error,
      );
    }
  }

  async pumpReplayBatch(limit?: number): Promise<ReplayPumpResult> {
    const batch = this.#runtime.claimManagedReplayBatch(limit);
    await this.#notifyReplayChange();

    if (batch.entries.length === 0) {
      await this.#notifyReplayChange();
      return {
        snapshot: this.#runtime.getReplaySnapshot(),
        claimedCount: 0,
        deliveredCount: 0,
        completed: batch.isDrainComplete,
      };
    }

    const claimedRowIds: number[] = [];

    try {
      for (const entry of batch.entries) {
        claimedRowIds.push(entry.rowId);
        await this.#handlers.deliverToDedupe(entry.event, {
          rowId: entry.rowId,
          sourceStreamId: entry.sourceStreamId,
          deliveryMode: "replay_through_dedupe",
          replay: true,
        });
      }

      const snapshot = this.#runtime.acknowledgeManagedReplayBatch(claimedRowIds);
      await this.#notifyReplayChange();
      return {
        snapshot,
        claimedCount: claimedRowIds.length,
        deliveredCount: claimedRowIds.length,
        completed: snapshot.state === "completed" || snapshot.state === "idle",
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown replay failure";
      const snapshot = this.#runtime.failManagedReplay(message, claimedRowIds);
      await this.#notifyReplayChange();
      return {
        snapshot,
        claimedCount: claimedRowIds.length,
        deliveredCount: 0,
        completed: false,
      };
    }
  }

  async reconcileRecovery(limit?: number): Promise<ReplayPumpResult | null> {
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

    return this.pumpReplayBatch(limit);
  }

  close(): void {
    this.#runtime.close();
  }

  async #notifyReplayChange(): Promise<void> {
    await this.#handlers.onReplayStateChange?.(this.#runtime.getReplaySnapshot());
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

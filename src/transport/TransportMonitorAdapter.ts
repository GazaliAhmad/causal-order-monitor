import { MonitorRuntime } from "../runtime/MonitorRuntime.js";
import type { MonitorConfig } from "../types/config.js";
import type {
  MonitorComponent,
  MonitorDeliveryMode,
  MonitorIngressDecision,
  MonitorIngressEvent,
} from "../types/events.js";
import type {
  MonitorSnapshot,
  ReplaySessionSnapshot,
} from "../types/snapshots.js";

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
    this.#handlers = handlers;
  }

  getRuntime(): MonitorRuntime {
    return this.#runtime;
  }

  getSnapshot(): MonitorSnapshot {
    return this.#runtime.getSnapshot();
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
    await this.#handlers.onDecision?.(event, decision, rowId);

    if (decision.action === "buffer_only" || decision.action === "pause") {
      await this.#handlers.onBuffered?.(event, decision, rowId);
      return {
        rowId,
        decision,
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
      forwardedTo: "dedupe",
    };
  }

  async pumpReplayBatch(limit?: number): Promise<ReplayPumpResult> {
    const batch = this.#runtime.claimReplayBatch(limit);
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

      const snapshot = this.#runtime.acknowledgeReplayBatch(claimedRowIds);
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
      const snapshot = this.#runtime.failReplay(message, claimedRowIds);
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
    const backlog = this.#runtime.getReservoirStats().totalPendingRows;

    if (backlog === 0) {
      return null;
    }

    if (snapshot.state === "idle" || snapshot.state === "failed") {
      this.#runtime.queueReplay();
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
}

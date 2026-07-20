import type { TransportMonitorAdapter } from "../transport/TransportMonitorAdapter.js";
import { LifecycleDispatcher } from "../lifecycle/LifecycleDispatcher.js";

export interface MonitorSchedulerTimerApi {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface MonitorSchedulerOptions {
  adapter: TransportMonitorAdapter;
  healthProbe?: () => Promise<void> | void;
  healthIntervalMs?: number;
  replayIntervalMs?: number;
  pruneIntervalMs?: number;
  replayBatchSize?: number;
  closeAdapterOnStop?: boolean;
  timers?: MonitorSchedulerTimerApi;
  now?: () => bigint;
  onError?: (error: unknown) => void;
}

export interface MonitorSchedulerState {
  status: "stopped" | "running";
  tickCount: number;
  lastError: unknown | null;
}

const DEFAULT_INTERVAL_MS = 1_000;

export class MonitorScheduler {
  readonly #adapter: TransportMonitorAdapter;
  readonly #healthProbe?: () => Promise<void> | void;
  readonly #healthIntervalMs: number;
  readonly #replayIntervalMs: number;
  readonly #pruneIntervalMs: number;
  readonly #replayBatchSize?: number;
  readonly #closeAdapterOnStop: boolean;
  readonly #timers: MonitorSchedulerTimerApi;
  readonly #now: () => bigint;
  readonly #onError?: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #activeTick: Promise<void> | null = null;
  #status: MonitorSchedulerState["status"] = "stopped";
  #tickCount = 0;
  #lastError: unknown | null = null;
  #lastHealthAt = 0n;
  #lastReplayAt = 0n;
  #lastPruneAt = 0n;

  constructor(options: MonitorSchedulerOptions) {
    this.#adapter = options.adapter;
    this.#healthProbe = options.healthProbe;
    this.#healthIntervalMs = positiveInterval(options.healthIntervalMs);
    this.#replayIntervalMs = positiveInterval(options.replayIntervalMs);
    this.#pruneIntervalMs = positiveInterval(options.pruneIntervalMs);
    this.#replayBatchSize = options.replayBatchSize;
    this.#closeAdapterOnStop = options.closeAdapterOnStop ?? false;
    this.#timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this.#now = options.now ?? (() => BigInt(Date.now()));
    this.#onError = options.onError;
  }

  getState(): MonitorSchedulerState {
    return {
      status: this.#status,
      tickCount: this.#tickCount,
      lastError: this.#lastError,
    };
  }

  start(): void {
    if (this.#status === "running") return;
    this.#status = "running";
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    if (this.#status === "stopped" && this.#activeTick === null) return;
    this.#status = "stopped";
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    const activeTick = this.#activeTick;
    if (activeTick !== null) await activeTick;
    if (this.#closeAdapterOnStop) this.#adapter.close();
  }

  async tick(): Promise<void> {
    if (this.#status !== "running") return;
    if (this.#activeTick !== null) return this.#activeTick;
    const operation = this.#runTick();
    this.#activeTick = operation;
    try {
      await operation;
    } finally {
      if (this.#activeTick === operation) this.#activeTick = null;
    }
  }

  #schedule(delayMs: number): void {
    if (this.#status !== "running" || this.#timer !== null) return;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      void this.tick().finally(() => this.#schedule(this.#nextDelayMs()));
    }, Math.max(0, Math.ceil(delayMs)));
  }

  async #runTick(): Promise<void> {
    this.#tickCount += 1;
    const now = this.#now();
    let outcome = "completed";
    try {
      if (this.#healthProbe && elapsedMs(now, this.#lastHealthAt) >= this.#healthIntervalMs) {
        await this.#healthProbe();
        this.#lastHealthAt = now;
      }
      if (elapsedMs(now, this.#lastReplayAt) >= this.#replayIntervalMs) {
        if (this.#replayTargetsOnline()) {
          await this.#adapter.reconcileRecovery(this.#replayBatchSize);
        }
        this.#lastReplayAt = now;
      }
      if (elapsedMs(now, this.#lastPruneAt) >= this.#pruneIntervalMs) {
        this.#adapter.getRuntime().pruneReservoir();
        this.#lastPruneAt = now;
      }
    } catch (error) {
      outcome = "failed";
      this.#lastError = error;
      this.#onError?.(error);
    } finally {
      try {
        const endedAt = this.#now();
        (this.#adapter.lifecycle as LifecycleDispatcher).publish({
          type: "operationDurationObserved",
          occurredAtMs: endedAt.toString(),
          operation: "scheduler.tick",
          durationMs: (endedAt >= now ? endedAt - now : 0n).toString(),
          outcome,
        });
      } catch {
        // Lifecycle observation is best effort and cannot alter scheduler outcomes.
      }
    }
  }

  #nextDelayMs(): number {
    const snapshot = this.#adapter.getReplaySnapshot();
    const retryAt = snapshot.nextRetryAt;
    if (retryAt !== null) {
      const remaining = retryAt - this.#now();
      if (remaining > 0n) return Number(remaining > 2_147_483_647n ? 2_147_483_647n : remaining);
    }
    return Math.min(this.#healthIntervalMs, this.#replayIntervalMs, this.#pruneIntervalMs);
  }

  #replayTargetsOnline(): boolean {
    const health = this.#adapter.getRuntime().getHealthSnapshot();
    return health.dedupe.state === "online" && health["causal-order"].state === "online";
  }
}

function positiveInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Scheduler intervals must be positive finite numbers.");
  return value;
}

function elapsedMs(now: bigint, previous: bigint): number {
  const elapsed = now - previous;
  return Number(elapsed > 2_147_483_647n ? 2_147_483_647n : elapsed);
}

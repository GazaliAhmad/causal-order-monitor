import { MonitorClosedError } from "../boundary.js";
import type { MonitorLifecycleConfig } from "../types/config.js";
import {
  MONITOR_LIFECYCLE_EVENT_NAMES,
  type MonitorLifecycleEvent,
  type MonitorLifecycleEventName,
  type MonitorLifecycleEvents,
  type MonitorLifecycleFacet,
  type MonitorLifecycleFlushResult,
  type MonitorLifecycleLastDropV1,
  type MonitorLifecycleListener,
  type MonitorLifecycleSnapshotV1,
} from "../types/lifecycle.js";

interface FlushWaiter {
  resolve: (result: MonitorLifecycleFlushResult) => void;
  timeout: NodeJS.Timeout | null;
}

interface ListenerSubscription {
  listener: MonitorLifecycleListener<MonitorLifecycleEventName>;
}

function incrementSaturating(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value as Readonly<T>;
  }
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function snapshotEvent<T extends MonitorLifecycleEvent>(event: T): Readonly<T> {
  const copied = structuredClone(event);
  if (!MONITOR_LIFECYCLE_EVENT_NAMES.includes(copied.type)) {
    throw new TypeError(`Unsupported lifecycle event type '${String(copied.type)}'.`);
  }
  if (!/^\d+$/.test(copied.occurredAtMs)) {
    throw new TypeError("Lifecycle occurredAtMs must be an unsigned decimal string.");
  }
  stripPayloadFields(copied);
  return deepFreeze(copied);
}

function stripPayloadFields(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return;
  seen.add(value as object);
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["payload", "payloadJson", "serializedEvent"]) delete record[key];
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    stripPayloadFields(nested, seen);
  }
}

export class LifecycleDispatcher implements MonitorLifecycleFacet {
  readonly #config: MonitorLifecycleConfig;
  readonly #now: () => bigint;
  readonly #listeners = new Map<MonitorLifecycleEventName, Set<ListenerSubscription>>();
  readonly #queue: Readonly<MonitorLifecycleEvent>[] = [];
  readonly #flushWaiters = new Set<FlushWaiter>();
  #active = false;
  #scheduled = false;
  #closed = false;
  #subscriberCount = 0;
  #droppedTotal = 0;
  #listenerFailureTotal = 0;
  #lastDrop: MonitorLifecycleLastDropV1 | null = null;

  constructor(config: MonitorLifecycleConfig, now: () => bigint) {
    if (!Number.isSafeInteger(config.queueCapacity) || config.queueCapacity <= 0) {
      throw new TypeError("lifecycle.queueCapacity must be a positive safe integer.");
    }
    if (config.overflowPolicy !== "drop_oldest") {
      throw new TypeError("lifecycle.overflowPolicy must be 'drop_oldest'.");
    }
    if (typeof config.shutdownFlushTimeoutMs !== "bigint" || config.shutdownFlushTimeoutMs < 0n) {
      throw new TypeError("lifecycle.shutdownFlushTimeoutMs must be a non-negative bigint.");
    }
    this.#config = { ...config };
    this.#now = now;
  }

  subscribe<K extends MonitorLifecycleEventName>(
    eventName: K,
    listener: MonitorLifecycleListener<K>,
  ): () => void {
    if (this.#closed) throw new MonitorClosedError("subscribe to lifecycle observations");
    if (!MONITOR_LIFECYCLE_EVENT_NAMES.includes(eventName)) {
      throw new TypeError(`Unsupported lifecycle event name '${String(eventName)}'.`);
    }
    if (typeof listener !== "function") {
      throw new TypeError("Lifecycle listener must be a function.");
    }
    let listeners = this.#listeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(eventName, listeners);
    }
    const subscription: ListenerSubscription = {
      listener: listener as MonitorLifecycleListener<MonitorLifecycleEventName>,
    };
    listeners.add(subscription);
    this.#subscriberCount += 1;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      if (listeners?.delete(subscription)) this.#subscriberCount -= 1;
      if (listeners?.size === 0) this.#listeners.delete(eventName);
    };
  }

  publish<K extends MonitorLifecycleEventName>(event: MonitorLifecycleEvents[K]): boolean {
    if (this.#closed) return false;
    const immutableEvent = snapshotEvent(event);
    if (this.#queue.length >= this.#config.queueCapacity) {
      const dropped = this.#queue.shift();
      if (dropped) this.#recordDrop(dropped, "queue_overflow");
    }
    this.#queue.push(immutableEvent);
    this.#scheduleDrain();
    return true;
  }

  flush(timeoutMs = this.#config.shutdownFlushTimeoutMs): Promise<MonitorLifecycleFlushResult> {
    if (typeof timeoutMs !== "bigint" || timeoutMs < 0n) {
      return Promise.reject(new TypeError("Lifecycle flush timeoutMs must be a non-negative bigint."));
    }
    if (this.#closed) return Promise.resolve(this.#flushResult("closed"));
    if (!this.#active && this.#queue.length === 0) {
      return Promise.resolve(this.#flushResult("drained"));
    }
    return new Promise((resolve) => {
      const waiter: FlushWaiter = { resolve, timeout: null };
      const boundedTimeout = Number(
        timeoutMs > BigInt(2_147_483_647) ? 2_147_483_647n : timeoutMs,
      );
      waiter.timeout = setTimeout(() => {
        if (!this.#flushWaiters.delete(waiter)) return;
        resolve(this.#flushResult("timed_out"));
      }, boundedTimeout);
      this.#flushWaiters.add(waiter);
    });
  }

  getSnapshot(): MonitorLifecycleSnapshotV1 {
    return deepFreeze({
      schema: "causal-order-monitor/lifecycle-snapshot",
      version: 1,
      generatedAtMs: this.#now().toString(),
      status: this.#closed ? "closed" : "open",
      queueDepth: this.#queue.length,
      queueCapacity: this.#config.queueCapacity,
      overflowPolicy: this.#config.overflowPolicy,
      subscriberCount: this.#subscriberCount,
      droppedTotal: this.#droppedTotal,
      listenerFailureTotal: this.#listenerFailureTotal,
      lastDrop: this.#lastDrop,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const event of this.#queue.splice(0)) this.#recordDrop(event, "shutdown");
    this.#listeners.clear();
    this.#subscriberCount = 0;
    for (const waiter of this.#flushWaiters) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(this.#flushResult("closed"));
    }
    this.#flushWaiters.clear();
  }

  #scheduleDrain(): void {
    if (this.#scheduled || this.#active || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#drainNext();
    });
  }

  async #drainNext(): Promise<void> {
    if (this.#active || this.#closed) return;
    const event = this.#queue.shift();
    if (!event) {
      this.#resolveDrainedWaiters();
      return;
    }
    this.#active = true;
    const listeners = [...(this.#listeners.get(event.type) ?? [])];
    await Promise.allSettled(
      listeners.map(async ({ listener }) => {
        try {
          await listener(event as never);
        } catch {
          if (!this.#closed) {
            this.#listenerFailureTotal = incrementSaturating(this.#listenerFailureTotal);
          }
        }
      }),
    );
    this.#active = false;
    if (this.#closed) return;
    if (this.#queue.length === 0) this.#resolveDrainedWaiters();
    else this.#scheduleDrain();
  }

  #recordDrop(event: Readonly<MonitorLifecycleEvent>, reason: MonitorLifecycleLastDropV1["reason"]): void {
    this.#droppedTotal = incrementSaturating(this.#droppedTotal);
    this.#lastDrop = deepFreeze({
      occurredAtMs: this.#now().toString(),
      eventType: event.type,
      reason,
    });
  }

  #resolveDrainedWaiters(): void {
    for (const waiter of this.#flushWaiters) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(this.#flushResult("drained"));
    }
    this.#flushWaiters.clear();
  }

  #flushResult(status: MonitorLifecycleFlushResult["status"]): MonitorLifecycleFlushResult {
    return deepFreeze({ status, queueDepth: this.#queue.length, activeDispatch: this.#active });
  }
}

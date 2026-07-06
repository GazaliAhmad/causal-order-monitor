import type { MonitorHealthConfig } from "../types/config.js";
import type {
  MonitorComponent,
  MonitorHealthState,
  MonitorHealthUpdate,
} from "../types/events.js";
import type { MonitorComponentHealthSnapshot } from "../types/snapshots.js";

interface HealthTrackerComponentState {
  snapshot: MonitorComponentHealthSnapshot;
  lastHeartbeatAt: bigint;
}

function createComponentSnapshot(
  component: MonitorComponent,
  observedAt: bigint,
): MonitorComponentHealthSnapshot {
  return {
    component,
    state: "online",
    observedAt,
    lastChangedAt: observedAt,
    reasonCode: null,
    details: {},
  };
}

export class HealthTracker {
  readonly #config: MonitorHealthConfig;
  readonly #now: () => bigint;
  readonly #components: Record<MonitorComponent, HealthTrackerComponentState>;

  constructor(config: MonitorHealthConfig, now: () => bigint) {
    this.#config = config;
    this.#now = now;
    const observedAt = now();
    this.#components = {
      transport: {
        snapshot: createComponentSnapshot("transport", observedAt),
        lastHeartbeatAt: observedAt,
      },
      dedupe: {
        snapshot: createComponentSnapshot("dedupe", observedAt),
        lastHeartbeatAt: observedAt,
      },
      "causal-order": {
        snapshot: createComponentSnapshot("causal-order", observedAt),
        lastHeartbeatAt: observedAt,
      },
    };
  }

  getSnapshot(): Record<MonitorComponent, MonitorComponentHealthSnapshot> {
    return {
      transport: {
        ...this.#components.transport.snapshot,
        details: { ...this.#components.transport.snapshot.details },
      },
      dedupe: {
        ...this.#components.dedupe.snapshot,
        details: { ...this.#components.dedupe.snapshot.details },
      },
      "causal-order": {
        ...this.#components["causal-order"].snapshot,
        details: { ...this.#components["causal-order"].snapshot.details },
      },
    };
  }

  getComponentSnapshot(component: MonitorComponent): MonitorComponentHealthSnapshot {
    const snapshot = this.#components[component].snapshot;
    return {
      ...snapshot,
      details: { ...snapshot.details },
    };
  }

  updateComponentHealth(
    component: MonitorComponent,
    update: MonitorHealthUpdate,
  ): MonitorComponentHealthSnapshot {
    const componentState = this.#components[component];
    const observedAt = update.observedAt ?? this.#now();
    const previous = componentState.snapshot;
    const nextState = update.state;

    componentState.snapshot = {
      component,
      state: nextState,
      observedAt,
      lastChangedAt:
        previous.state === nextState ? previous.lastChangedAt : observedAt,
      reasonCode: update.reasonCode ?? null,
      details: update.details ?? {},
    };

    if (nextState !== "offline") {
      componentState.lastHeartbeatAt = observedAt;
    }

    return this.getComponentSnapshot(component);
  }

  observeHeartbeat(
    component: MonitorComponent,
    observedAt = this.#now(),
    details: Record<string, unknown> = {},
  ): MonitorComponentHealthSnapshot {
    const componentState = this.#components[component];
    componentState.lastHeartbeatAt = observedAt;
    return this.updateComponentHealth(component, {
      state: "online",
      observedAt,
      reasonCode: "heartbeat",
      details,
    });
  }

  refreshStates(at = this.#now()): Record<MonitorComponent, MonitorComponentHealthSnapshot> {
    const componentNames = [
      "transport",
      "dedupe",
      "causal-order",
    ] as const satisfies ReadonlyArray<MonitorComponent>;

    for (const component of componentNames) {
      const componentState = this.#components[component];
      const elapsed = at - componentState.lastHeartbeatAt;
      const thresholds = this.#resolveThresholds(component);
      const nextState = this.#resolveStateFromElapsed(elapsed, thresholds);

      if (nextState !== componentState.snapshot.state) {
        this.updateComponentHealth(component, {
          state: nextState,
          observedAt: at,
          reasonCode: "heartbeat_timeout",
          details: {
            elapsedSinceHeartbeatMs: elapsed.toString(),
          },
        });
      } else {
        componentState.snapshot = {
          ...componentState.snapshot,
          observedAt: at,
        };
      }
    }

    return this.getSnapshot();
  }

  #resolveThresholds(component: MonitorComponent) {
    if (component === "transport") {
      return this.#config.transport;
    }
    if (component === "dedupe") {
      return this.#config.dedupe;
    }
    return this.#config.causalOrder;
  }

  #resolveStateFromElapsed(
    elapsed: bigint,
    thresholds: { degradedAfterMs: bigint; offlineAfterMs: bigint },
  ): MonitorHealthState {
    if (elapsed >= thresholds.offlineAfterMs) {
      return "offline";
    }
    if (elapsed >= thresholds.degradedAfterMs) {
      return "degraded";
    }
    return "online";
  }
}

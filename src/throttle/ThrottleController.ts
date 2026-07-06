import type {
  MonitorThrottleConfig,
  MonitorThrottleTierConfig,
} from "../types/config.js";
import type {
  MonitorRoutingMode,
  MonitorThrottleTier,
} from "../types/events.js";
import type { ReservoirStats } from "../types/snapshots.js";

export interface ThrottleDecision {
  tier: MonitorThrottleTier;
  targetEventsPerSecond: number;
  targetBatchSize: number;
  reason: string;
}

export class ThrottleController {
  readonly #config: MonitorThrottleConfig;

  constructor(config: MonitorThrottleConfig) {
    this.#config = config;
  }

  decide(
    routingMode: MonitorRoutingMode,
    reservoir: ReservoirStats,
  ): ThrottleDecision {
    if (routingMode === "full_outage_buffer" || routingMode === "order_buffer_only") {
      return this.#toDecision("paused", "downstream ordering path unavailable");
    }

    if (routingMode === "replay_through_dedupe") {
      return this.#toDecision("very_slow", "replay session active");
    }

    if (routingMode === "dedupe_bypass_throttled") {
      if (reservoir.totalPendingRows >= 10_000) {
        return this.#toDecision("paused", "dedupe bypass backlog exceeds hard safety threshold");
      }
      if (reservoir.totalPendingRows >= 2_000) {
        return this.#toDecision("very_slow", "dedupe bypass backlog is elevated");
      }
      return this.#toDecision("slow", "dedupe offline, protect causal-order");
    }

    if (reservoir.totalPendingRows >= 20_000) {
      return this.#toDecision("very_slow", "backlog remains very high");
    }

    if (reservoir.totalPendingRows >= 5_000) {
      return this.#toDecision("slow", "backlog is elevated");
    }

    return this.#toDecision(this.#config.defaultTier, "normal operating posture");
  }

  #toDecision(
    tier: MonitorThrottleTier,
    reason: string,
  ): ThrottleDecision {
    const target = this.#resolveTierConfig(tier);
    return {
      tier,
      targetEventsPerSecond: target.maxEventsPerSecond,
      targetBatchSize: target.batchSize,
      reason,
    };
  }

  #resolveTierConfig(tier: MonitorThrottleTier): MonitorThrottleTierConfig {
    switch (tier) {
      case "slow":
        return this.#config.slow;
      case "very_slow":
        return this.#config.verySlow;
      case "paused":
        return this.#config.paused;
      default:
        return this.#config.open;
    }
  }
}

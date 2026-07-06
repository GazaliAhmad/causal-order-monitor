import { ThrottleController } from "../throttle/ThrottleController.js";
import type {
  MonitorDeliveryMode,
  MonitorIngressDecision,
  MonitorRoutingMode,
} from "../types/events.js";
import type { ReservoirStats } from "../types/snapshots.js";

export class DeliveryRouter {
  readonly #throttleController: ThrottleController;

  constructor(throttleController: ThrottleController) {
    this.#throttleController = throttleController;
  }

  decideIngress(
    routingMode: MonitorRoutingMode,
    reservoir: ReservoirStats,
  ): MonitorIngressDecision {
    const throttle = this.#throttleController.decide(routingMode, reservoir);

    if (throttle.tier === "paused") {
      return {
        action:
          routingMode === "full_outage_buffer" || routingMode === "order_buffer_only"
            ? "buffer_only"
            : "pause",
        routingMode,
        deliveryMode: this.#resolveDeliveryMode(routingMode),
        throttleTier: throttle.tier,
        targetEventsPerSecond: throttle.targetEventsPerSecond,
        targetBatchSize: throttle.targetBatchSize,
        reason: throttle.reason,
      };
    }

    return {
      action:
        routingMode === "full_outage_buffer" || routingMode === "order_buffer_only"
          ? "buffer_only"
          : "accept",
      routingMode,
      deliveryMode: this.#resolveDeliveryMode(routingMode),
      throttleTier: throttle.tier,
      targetEventsPerSecond: throttle.targetEventsPerSecond,
      targetBatchSize: throttle.targetBatchSize,
      reason: throttle.reason,
    };
  }

  #resolveDeliveryMode(routingMode: MonitorRoutingMode): MonitorDeliveryMode {
    switch (routingMode) {
      case "dedupe_bypass_throttled":
        return "dedupe_bypass";
      case "order_buffer_only":
        return "order_buffer_only";
      case "full_outage_buffer":
        return "full_outage_buffer";
      case "replay_through_dedupe":
        return "replay_through_dedupe";
      default:
        return "normal";
    }
  }
}

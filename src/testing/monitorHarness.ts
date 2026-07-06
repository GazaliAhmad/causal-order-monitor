export type MonitorHarnessScenarioId =
  | "monitor-healthy-rolling-4h"
  | "monitor-transport-outage-burst"
  | "monitor-dedupe-outage"
  | "monitor-order-outage"
  | "monitor-dual-outage"
  | "monitor-recovery-through-dedupe";

export type MonitorHarnessRuntimeKind =
  | "deployment-runtime"
  | "adapter-runtime";

export interface MonitorHarnessArtifactSpec {
  fileName: string;
  purpose: string;
}

export interface MonitorHarnessExpectation {
  description: string;
}

export interface MonitorHarnessScenarioDefinition {
  id: MonitorHarnessScenarioId;
  runtimeKinds: ReadonlyArray<MonitorHarnessRuntimeKind>;
  title: string;
  description: string;
  expectedArtifacts: ReadonlyArray<MonitorHarnessArtifactSpec>;
  expectedRoutingModes: ReadonlyArray<string>;
  expectations: ReadonlyArray<MonitorHarnessExpectation>;
}

export const monitorHarnessArtifacts: ReadonlyArray<MonitorHarnessArtifactSpec> =
  [
    {
      fileName: "monitor-heartbeats.ndjson",
      purpose: "Component heartbeat and blackout timeline for transport, dedupe, and causal-order.",
    },
    {
      fileName: "monitor-health.ndjson",
      purpose: "Health-state transitions, routing changes, and throttle posture.",
    },
    {
      fileName: "monitor-replay.ndjson",
      purpose: "Replay session lifecycle, batch drain progress, and replay failures.",
    },
    {
      fileName: "monitor-summary.json",
      purpose: "Compact run summary with backlog, routing, replay, and retention signals.",
    },
  ];

export const monitorHarnessScenarios: ReadonlyArray<MonitorHarnessScenarioDefinition> =
  [
    {
      id: "monitor-healthy-rolling-4h",
      runtimeKinds: ["deployment-runtime", "adapter-runtime"],
      title: "Healthy rolling reservoir",
      description:
        "Validates steady-state buffering, pruning, and health visibility with all downstream components online.",
      expectedArtifacts: monitorHarnessArtifacts,
      expectedRoutingModes: ["normal"],
      expectations: [
        { description: "rolling retention stays bounded at 4 hours" },
        { description: "no replay session starts during healthy flow" },
        { description: "throttle tier remains open for normal throughput" },
      ],
    },
    {
      id: "monitor-transport-outage-burst",
      runtimeKinds: ["adapter-runtime"],
      title: "Transport outage and reconnect burst",
      description:
        "Exercises transport blackout visibility and reconnect burst control without inventing separate monitor logic in the harness.",
      expectedArtifacts: monitorHarnessArtifacts,
      expectedRoutingModes: ["normal", "order_buffer_only"],
      expectations: [
        { description: "transport blackout is visible in heartbeat artifacts" },
        { description: "reconnect burst markers appear in health or summary output" },
        { description: "recovery does not bypass monitor routing decisions" },
      ],
    },
    {
      id: "monitor-dedupe-outage",
      runtimeKinds: ["deployment-runtime", "adapter-runtime"],
      title: "Dedupe outage with throttled bypass",
      description:
        "Verifies that monitor can continue feeding causal-order directly while slowing ingress when dedupe is offline.",
      expectedArtifacts: monitorHarnessArtifacts,
      expectedRoutingModes: ["dedupe_bypass_throttled"],
      expectations: [
        { description: "routing switches into dedupe bypass mode" },
        { description: "throttle tier drops below open during bypass" },
        { description: "buffer growth remains inspectable in summary output" },
      ],
    },
    {
      id: "monitor-order-outage",
      runtimeKinds: ["deployment-runtime", "adapter-runtime"],
      title: "Order outage with buffered recovery",
      description:
        "Confirms backlog accumulation while causal-order is offline and replay once the normal path is restored.",
      expectedArtifacts: monitorHarnessArtifacts,
      expectedRoutingModes: ["order_buffer_only", "replay_through_dedupe"],
      expectations: [
        { description: "live ingress buffers instead of forwarding to causal-order" },
        { description: "replay is recorded as a distinct recovery session" },
        { description: "live flow reopens only after replay completion" },
      ],
    },
    {
      id: "monitor-dual-outage",
      runtimeKinds: ["deployment-runtime", "adapter-runtime"],
      title: "Dual outage with hard retention ceiling",
      description:
        "Checks that monitor remains bounded when both dedupe and causal-order are unavailable.",
      expectedArtifacts: monitorHarnessArtifacts,
      expectedRoutingModes: ["full_outage_buffer", "replay_through_dedupe"],
      expectations: [
        { description: "buffer retention never exceeds the hard 6 hour ceiling" },
        { description: "expired undeliverable rows are visible as dead-letter outcomes" },
        { description: "recovery still returns through dedupe before normal reopen" },
      ],
    },
    {
      id: "monitor-recovery-through-dedupe",
      runtimeKinds: ["deployment-runtime", "adapter-runtime"],
      title: "Recovery through dedupe",
      description:
        "Validates the key current-line rule that backlog replay always routes back through restored dedupe.",
      expectedArtifacts: monitorHarnessArtifacts,
      expectedRoutingModes: ["replay_through_dedupe", "normal"],
      expectations: [
        { description: "replay target stays on the dedupe then order path" },
        { description: "replay drain reaches zero pending rows" },
        { description: "health confirmation gate completes before live reopen" },
      ],
    },
  ];

export interface MonitorHarnessAdapterContract {
  ingest(event: Record<string, unknown>): Promise<void> | void;
  updateComponentHealth(
    component: "transport" | "dedupe" | "causal-order",
    state: string,
  ): void;
  getSnapshot(): Record<string, unknown>;
  reconcileRecovery?(): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  destroy(): void;
}

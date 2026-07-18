# Event Timing Evidence

`MonitorEventTimingEvidence` is a type-only contract for handing neutral timing facts to application-owned policy code.

```ts
import type { MonitorEventTimingEvidence } from "@causal-order/monitor/types";

const monitorIngestTimeMs = event.ingestedAt;
if (monitorIngestTimeMs === undefined) {
  throw new Error("Monitor ingest time must be captured before producing timing evidence");
}

const observedTimeMs = BigInt(Date.now());
const timing: MonitorEventTimingEvidence = {
  eventTimeMs: event.clock.physicalTimeMs,
  monitorIngestTimeMs,
  observedTimeMs,
  latenessMs: observedTimeMs - event.clock.physicalTimeMs,
  causalMetadata: {
    eventId: event.id,
    nodeId: event.nodeId,
  },
};
```

The type is also available from the package root:

```ts
import type { MonitorEventTimingEvidence } from "@causal-order/monitor";
```

`latenessMs` is signed, so negative values preserve clock-skew evidence instead of being silently classified. The interface adds no runtime behavior, persistence requirement, processing horizon, threshold, or policy preset.

The monitor supplies evidence but does not decide what “too late” means. Application owners remain responsible for accepting, flagging, quarantining, compensating, or discarding late events.

SQLite `dead_letter` is different: it is an operational recovery state for buffered rows that exceed monitor retention, not a business-lateness decision.

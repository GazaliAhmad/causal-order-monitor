# Monitor Order Outage 8h Wall-Clock Validation

This document summarizes the sanitized results for the 8-node overnight wall-clock validation run of `/monitor` under the `monitor-order-outage` scenario.

Matching machine-readable artifact:

- `validation/monitor-order-outage-8h-wallclock-8nodes.json`

## Scenario

- profile: `monitor-order-outage`
- scenario: `monitor-order-outage`
- adapter: `@causal-order/transport/testing`
- topology: 8 nodes
- nodes: `edge-a`, `edge-b`, `edge-c`, `edge-d`, `edge-e`, `edge-f`, `edge-g`, `edge-h`
- target duration: `8h`
- time scale: `1x` wall clock
- report interval: `15m`

## Timing

- started: `2026-07-12T10:21:15.386Z`
- finished: `2026-07-12T18:23:57.303Z`
- wall elapsed: `8h 2m 42s`
- simulated elapsed: `28961917 ms`

The additional time beyond the eight-hour generation target was tail-drain time.

## Workload Shape

- ingress target: `15 events/sec`
- chaos multiplier: `1.7`
- batch size: `200`
- late arrival policy: `flag`
- monitor enabled: `true`

## Outcome

- run status: `completed`
- received events: `652413`
- ordered events: `643129`
- dedupe dropped duplicates: `13334`
- anomalies: `282780`
- anomaly severity: `warning` for all recorded anomalies
- anomaly types:
  - `sequence_regression`: `8835`
  - `late_arrival`: `273945`

The anomaly counts are expected stress evidence from the configured profile and did not prevent recovery or drained completion.

## Monitor Outcome

- buffered events: `19924`
- forwarded to dedupe: `656463`
- forwarded directly to order: `0`
- final replay state: `idle`
- ended drained: `true`
- pending rows at end: `0`
- retry-waiting rows at end: `0`
- consecutive replay failures at end: `0`
- duplicate-leak artifact emitted: `false`

Routing and delivery modes observed:

- `normal`: `632489`
- `order_buffer_only`: `11454`
- `replay_through_dedupe`: `8470`

The outage-buffered and replay-through-dedupe counts sum to the monitor's `19924` buffered-event count.

## Interpretation

Validated by this run:

- normal flow before and after the ordering outage
- accepted buffering through `order_buffer_only` while ordering was unavailable
- recovery replay through dedupe
- return to an `idle` replay state
- full reservoir drain to zero pending and retry-waiting rows
- no terminal replay failure or duplicate-leak artifact

Not validated by this run:

- the full dual-downstream-outage path
- an injected replay-delivery failure and retry-backoff cycle
- the protective stop path that would surface as HTTP `503 Service Unavailable`

## Sanitization Notes

This validation summary intentionally omits absolute host filesystem paths, the local SQLite database path, peer instance identifiers, and other machine-specific runtime details. It retains scenario labels, node labels, timestamps, counts, and behavioral evidence needed for validation review.

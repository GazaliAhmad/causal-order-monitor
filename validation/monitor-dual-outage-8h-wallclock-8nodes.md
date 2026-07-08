# Monitor Dual Outage 8h Wall-Clock Validation

This document summarizes the sanitized results for the 8-node overnight wall-clock validation run of `/monitor` under the `monitor-dual-outage` scenario.

Matching machine-readable artifact:

- `validation/monitor-dual-outage-8h-wallclock-8nodes.json`

## Scenario

- profile: `monitor-dual-outage`
- scenario: `monitor-dual-outage`
- adapter: `@causal-order/transport/testing`
- topology: 8 nodes
- nodes: `edge-a`, `edge-b`, `edge-c`, `edge-d`, `edge-e`, `edge-f`, `edge-g`, `edge-h`
- target duration: `8h`
- time scale: `1x` wall clock

## Timing

- started: `2026-07-07T16:22:08.627Z`
- finished: `2026-07-08T00:24:24.031Z`
- wall elapsed: `8h 2m 15s`
- simulated elapsed: `28935404 ms`

## Workload Shape

- ingress target: `18 events/sec`
- chaos multiplier: `1.9`
- batch size: `200`
- late arrival policy: `flag`
- monitor enabled: `true`

## Outcome

- received events: `644044`
- ordered events: `636710`
- dedupe dropped duplicates: `7334`
- anomalies: `256334`
- anomaly types:
  - `sequence_regression`: `11325`
  - `late_arrival`: `245009`

## Monitor Outcome

- buffered events: `14031`
- forwarded to dedupe: `644044`
- forwarded directly to order: `0`
- final replay state: `idle`
- ended drained: `true`
- pending rows at end: `0`
- retry waiting rows at end: `0`
- pause detected: `false`

Routing modes observed:

- `normal`: `630013`
- `full_outage_buffer`: `13577`
- `replay_through_dedupe`: `454`

Delivery modes observed:

- `normal`: `630013`
- `full_outage_buffer`: `13577`
- `replay_through_dedupe`: `454`

## Evidence

Healthy start:

- `2026-07-07T16:22:08.781Z` dedupe `online`
- `2026-07-07T16:22:08.790Z` causal-order `online`

Deep outage buffering:

- `2026-07-07T18:48:08.767Z`
- action: `buffer_only`
- routing mode: `full_outage_buffer`
- delivery mode: `full_outage_buffer`
- reason: `downstream ordering path unavailable`

Replay lifecycle:

- `2026-07-07T19:00:08.862Z` replay `queued` with `13577` queued events
- `2026-07-07T19:00:08.911Z` replay `running`
- `2026-07-07T19:00:43.980Z` replay `completed` with `13932` delivered events

Pause search:

- `action:"pause"` matches: `0`
- pause routing matches: `0`
- summary pause matches: `0`

## Interpretation

Validated by this run:

- normal flow before the outage
- deep outage buffering in `full_outage_buffer`
- recovery replay through dedupe
- full drain back to zero pending rows

Not validated by this run:

- the protective stop path that would surface as HTTP `503 Service Unavailable`
- an actual `pause` admission decision in the live wall-clock scenario

## Sanitization Notes

This validation summary intentionally omits:

- absolute host filesystem paths
- temp SQLite database locations
- peer instance identifiers
- other machine-specific runtime details

It keeps only the scenario labels, node labels, counts, timestamps, and behavioral evidence needed for validation review.

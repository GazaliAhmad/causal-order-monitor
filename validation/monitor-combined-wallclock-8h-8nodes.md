# Monitor Combined Fault Cycle 8h Wall-Clock Validation

This document summarizes the sanitized results for the eight-node, eight-hour wall-clock validation of the repository `v0.3.1` candidate under individual, paired, and triple transport, dedupe, and causal-order failures.

Matching machine-readable summary:

- `validation/monitor-combined-wallclock-8h-8nodes.json`

The complete generated report, including minute samples, is retained locally at `artifacts/validation/monitor-combined-wallclock-8h-8nodes.json` and is intentionally excluded from source control.

## Scenario

- monitor version: `0.3.1`
- topology: 8 nodes
- nodes: `edge-a`, `edge-b`, `edge-c`, `edge-d`, `edge-e`, `edge-f`, `edge-g`, `edge-h`
- target duration: `8h`
- time scale: `1x` wall clock
- ingress rate: `15 events/sec`
- intentional duplicate rate: `1%`
- event jitter: `250 ms`
- maximum allowed host loop gap: `30s`

The schedule covered healthy operation, each individual component failure, every two-component failure combination, a triple outage, and recovery between fault phases. Transport-offline emissions were retained in the runner's explicit upstream retry queue because monitor cannot persist an event it has not received.

## Timing

- started: `2026-07-14T14:34:54.022Z`
- finished: `2026-07-14T22:34:55.991Z`
- wall elapsed: `8h 0m 1.969s`
- simulated elapsed: `8h`
- sleep or prolonged process stall detected: `false`

## Outcome

- status: `passed`
- generated emissions: `431999`
- generated unique events: `427737`
- generated duplicate emissions: `4262`
- accepted by monitor: `431999`
- refused before persistence: `0`
- indeterminate adapter outcomes: `0`
- unique events delivered to the simulated order sink: `427737`
- replay failures: `0`

## Buffering and Recovery

- emissions held upstream during transport failures: `112320`
- upstream emissions released after recovery: `112320`
- maximum upstream queue: `34560`
- monitor-buffered deliveries: `302400`
- replay deliveries through dedupe: `302400`
- maximum pending monitor rows: `25926`
- final upstream queue: `0`
- final monitor backlog: `0`
- final retry-waiting rows: `0`
- final replay state: `idle`

Every generated unique event reached the simulated order sink. All upstream-held work and monitor-buffered work recovered, and the run ended fully drained.

## Resource Evidence

- peak RSS: `132829184` bytes (`126.7 MiB`), below the `1024 MiB` limit
- peak heap used: `54033992` bytes (`51.5 MiB`)
- final/peak database size: `305483776` bytes (`291.3 MiB`)
- peak WAL size: `4420792` bytes (`4.2 MiB`), below the `512 MiB` limit
- peak pending rows: `25926`, below the `250000` limit

## Near-Full Physical Disk Evidence

The physical Windows filesystem containing the repository and SQLite reservoir was already near full during the run. At completion, monitor observed:

- filesystem capacity: `510392602624` bytes (`475.4 GiB`)
- filesystem available: `19375439872` bytes (`18.0 GiB`)
- filesystem used: `96.2%`
- storage pressure: `critical`

The final operator snapshot correctly remained:

- `status: "attention_required"`
- `affectedComponents: ["reservoir"]`
- `recommendedAction: "free_local_storage"`
- `storage.pressure: "critical"`
- `throttleTier: "very_slow"`

At the same time, the recovered data path was usable and accurately reported:

- `routingMode: "normal"`
- `admission.posture: "accepted_live"`
- `admission.httpStatus: 202`
- `admission.reasonCode: "MONITOR_LIVE_FLOW_AVAILABLE"`
- zero final backlog and idle replay

This is positive designed-behavior evidence. Monitor did not hide the host storage risk or falsely report an all-clear state, and the near-full disk did not cause data loss, an indeterminate outcome, replay failure, or failure to drain within this workload. It does not prove operation at zero free bytes; the filesystem still had approximately `18.0 GiB` available.

## Scope

This repository-local runner validates monitor admission, buffering, routing, upstream retry accounting, recovery replay, final drain, resource bounds, and operator/storage reporting. Its dedupe and causal-order handlers are simulated availability boundaries. It does not independently prove the ordering semantics of the real `@causal-order/dedupe` or `causal-order` packages.

## Interpretation

Validated by this run:

- continuous eight-hour process execution without a sleep/stall violation
- all single, paired, and triple fault phases
- lossless delivery of generated unique events to the simulated order sink
- complete upstream release and monitor replay-through-dedupe
- final drain with no replay or indeterminate failures
- bounded RSS, WAL, and pending-row peaks
- correct critical physical-disk pressure detection and actionable operator guidance while service continued within safe admission limits

Not validated by this run:

- operation after the physical filesystem exhausts all remaining space
- real downstream dedupe or causal-engine correctness
- cross-process or network-filesystem ownership guarantees


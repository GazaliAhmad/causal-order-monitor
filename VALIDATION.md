# Validation

This document records repository-facing validation commands and release evidence for `@causal-order/monitor`.

## Core Checks

Run the complete CI contract:

```bash
npm run ci
```

The default CI contract includes both 10,000-row threshold and retention/admission pressure scenarios so backlog-dependent ingress regressions remain release-blocking.

## Performance Baseline

Run all v0.5.0 comparative benchmark families with:

```bash
npm run benchmark:monitor
```

The detailed report is written under ignored `artifacts/validation/`. To retain a review summary explicitly, run:

```bash
npm run benchmark:monitor -- --summary-output validation/monitor-v0.5.0-performance-baseline.json
```

`npm run test:performance-baseline-contract` runs a smaller profile in CI. Both profiles cover capacity-disabled/enabled ingress, saturated refusal, replay drain, bounded pruning, startup/restart, three inspection surfaces, scheduler pacing/coalescing/shutdown, and four lifecycle-listener modes. A report is emitted only after correctness passes. Timing comparison requires matching environments and repeated runs; see [the performance baseline methodology](docs/performance-baselines.md).

## Phase 6 Sustained-load Qualification

Run the deterministic accelerated smoke profile with:

```bash
npm run test:monitor-phase6-smoke
```

The explicit qualification profiles are:

- `npm run test:monitor-phase6-medium` — 2-hour horizon at 240×
- `npm run test:monitor-phase6-long` — 8-hour horizon at 360×
- `npm run test:monitor-phase6-sustained` — 10 minutes continuously at 1×
- `node scripts/monitor-phase6-soak.mjs --profile wallclock` — explicit 8-hour 1× release-host burn-in

Accelerated horizons are not continuous wall-clock claims. Every profile uses eight nodes and correctness-gates capacity refusal/upstream ownership, replay through dedupe, an exact persisted retry deadline, scheduler pacing, repeated recovery, slow/failing lifecycle observers, restart overlap, ordering, final drain, resource trends, shutdown, SQLite integrity, and reopen. See [the retained operating envelopes and sizing method](docs/soak-qualification.md).

Validate the four tracked concise summaries with:

```bash
npm run test:phase6-soak-summary-contract
```

The v0.4.0 release retains the v0.3.0 consumer contract in `scripts/fixtures/v0.3.0-public-contract.mjs`. `npm run test:compatibility-audit` verifies every published runtime namespace, selected generated declaration literals and operation signatures, public class methods, configuration keys, raw and inspected snapshot shapes, operator snapshot schema/version and required fields, operation result shapes, and every schema-v2 table, column, and named index. The fixture is independent of current source enumeration so an accidental removal or reinterpretation cannot silently rewrite the expected baseline.

Individual checks are available through:

- `npm run check`
- `npm run test:compatibility-audit`
- `npm run test:config-env-resolution`
- `npm run test:concurrency-contract`
- `npm run test:crash-boundary-contract`
- `npm run test:export-contract`
- `npm run test:http-thresholds-8nodes`
- `npm run test:inspect-snapshot`
- `npm run test:monotonic-now`
- `npm run test:operator-snapshot-contract`
- `npm run test:operator-edge-state-contract`
- `npm run test:boundary-contract`
- `npm run test:snapshot-query-plan-contract`
- `npm run test:no-healthy-replay`
- `npm run test:payload-boundary-contract`
- `npm run test:prune-batching`
- `npm run test:replay-ownership-guard`
- `npm run test:retention-admission-contract`
- `npm run test:runtime-bootstrap`
- `npm run test:schema-compatibility`
- `npm run test:shutdown-lifecycle-contract`
- `npm run test:storage-failure-contract`
- `npm run test:storage-pressure-contract`
- `npm run test:terminal-retention-contract`
- `npm run test:wal-lifecycle-contract`
- `npm run test:backup-restore-contract`
- `npm run test:replay-safety`

## Operational Harness

Run the default three-node, 10-minute order-outage scenario at 60x speed with:

```bash
npm run harness:monitor -- --monitor-scenario monitor-order-outage --duration 10m --time-scale 60 --profile monitor-order-outage --run-name monitor-order-outage-10m-fast
```

Run the 8-node smoke suite with a 10-minute duration per scenario at 60x speed with:

```bash
npm run test:monitor-operational-smoke -- --duration 10m --time-scale 60
```

The smoke suite uses `edge-a` through `edge-h` and covers healthy rolling-buffer, order-outage, and dual-outage scenarios.

Run only the 8-node, 10-minute order-outage scenario with:

```bash
npm run harness:monitor -- --monitor-scenario monitor-order-outage --duration 10m --time-scale 60 --profile monitor-order-outage --node-ids edge-a,edge-b,edge-c,edge-d,edge-e,edge-f,edge-g,edge-h --run-name monitor-order-outage-10m-8nodes
```

The operational suites are:

- `npm run test:monitor-operational-smoke` — uses an 8-node default topology and a short scenario subset for CI and repeatable smoke confidence.
- `npm run test:monitor-operational-full` — uses an 8-node default topology and the broader monitor scenario set for production-shaped validation.

Run the dedicated eight-hour combined fault-cycle validation in a separate PowerShell window with:

```powershell
npm run test:monitor-combined-wallclock -- --duration 8h --time-scale 1 --node-ids edge-a,edge-b,edge-c,edge-d,edge-e,edge-f,edge-g,edge-h
```

This repository-local soak cycles through healthy operation; individual transport, dedupe, and causal-order failures; all three two-component combinations; a triple outage; and final recovery. Transport-offline emissions are held in an explicit upstream retry queue because monitor cannot persist events it has not received. The run records jitter, intentional duplicates, routing/operator postures, replay-through-dedupe, final drain, RSS/heap, database/WAL size, and threshold failures in `artifacts/validation/monitor-combined-wallclock-8h-8nodes.json`.

Keep the host awake for the complete run. By default, a real loop gap longer than 30 seconds fails the validation so system sleep or a prolonged process stall cannot be counted silently as continuous wall-clock evidence.

The completed v0.3.1 eight-hour run is preserved as tracked, sanitized evidence in:

- `validation/monitor-combined-wallclock-8h-8nodes.json`
- `validation/monitor-combined-wallclock-8h-8nodes.md`

The run passed every fault phase, delivered all `427737` generated unique events to the simulated order sink, released all `112320` transport-held emissions, replayed all `302400` buffered deliveries through dedupe, and ended with zero backlog and idle replay. The host filesystem was `96.2%` used with approximately `18.0 GiB` available. Monitor correctly retained `attention_required / free_local_storage` and critical storage pressure while the recovered path returned to normal accepted-live HTTP `202` behavior. This is designed storage-warning evidence, not a claim that operation with zero free bytes was tested.

## Threshold Contract

`npm run test:http-thresholds-8nodes` runs a deterministic 8-node wall-clock simulation proving:

- order-only outage continues returning monitor decisions equivalent to HTTP `202 Accepted` after the `4h` rolling window while prune ages out old buffered rows
- dual outage continues returning monitor decisions equivalent to HTTP `202 Accepted` after the `6h` ceiling, with dead-lettering during prune rather than immediate ingress rejection
- true protective-stop behavior maps to HTTP `503 Service Unavailable` when dedupe-only bypass pressure crosses the hard backlog threshold

## Release Evidence

The package published as `v0.5.0` passes:

- the complete CI and release-check contracts, including every focused Phase 6 capacity, lifecycle, benchmark, auxiliary-growth, retained-summary, and accelerated smoke gate
- packed-artifact imports, declarations, version identity, capacity errors/snapshots, and the 20-event lifecycle catalog
- the supported minimum and declared-range-latest peer-version matrix
- the packed full-stack capacity refusal, lifecycle observation, startup, outage, restart, retry, replay-through-dedupe, and resumed-delivery scenario
- all inherited compatibility, schema migration, accounting, crash, restart, replay, storage, ownership, scheduler, payload, concurrency, retention, and shutdown contracts
- retained environment-labelled benchmark and eight-node smoke, medium, accelerated eight-hour-horizon, and ten-minute continuous-load summaries

Repository metadata, the packed artifact, and the npm release agree on `0.5.0`.

The v0.4.0 packed-artifact, supported-stack, scheduler, ownership, startup-health, replay-concurrency, and compatibility evidence remains the inherited regression baseline.

The retained v0.3.3 compatibility-closure evidence remains historical:

- the complete default CI contract, including the retained v0.3.0 compatibility fixture and all 22 forced-termination boundaries
- the three-scenario eight-node operational smoke suite
- publication preparation and the complete release check, including npm publication dry run and its second full CI pass
- retained artifact packing and clean-consumer TypeScript/runtime verification

Retained v0.3.3 artifact:

- filename: `causal-order-monitor-0.3.3.tgz`
- files: `62`
- packed bytes: `55,763`
- unpacked bytes: `245,739`
- SHA-1: `c1c1aca78642a7e9f07dd0b7eeeee6c739338c00`
- integrity: `sha512-JmCu8BTmuMMYO+C9giBKJoaimVEAxELwkDb/3Dh5epgqysYxw1yWlagKSgBzaROw+VTTpXqg/3R7JT1/AzomOw==`

The clean consumer resolved monitor 0.3.3 with transport 0.1.2, dedupe 1.1.1, causal-order 1.0.0, testing 0.2.6, and TypeScript 6.0.3. It passed package/export version identity, declaration consumption, v1 JSON safety, admission, boundary, schema, and lifecycle checks.

Tracked evidence for the overnight 8-node wall-clock dual-outage run is stored in:

- `validation/monitor-dual-outage-8h-wallclock-8nodes.json`
- `validation/monitor-dual-outage-8h-wallclock-8nodes.md`

Tracked evidence for the v0.3.1 eight-node combined single/paired/triple fault-cycle run is stored in:

- `validation/monitor-combined-wallclock-8h-8nodes.json`
- `validation/monitor-combined-wallclock-8h-8nodes.md`

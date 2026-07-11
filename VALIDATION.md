# Validation

This document records repository-facing validation commands and release evidence for `@causal-order/monitor`.

## Core Checks

Run the complete CI contract:

```bash
npm run ci
```

Individual checks are available through:

- `npm run check`
- `npm run test:config-env-resolution`
- `npm run test:export-contract`
- `npm run test:http-thresholds-8nodes`
- `npm run test:inspect-snapshot`
- `npm run test:monotonic-now`
- `npm run test:no-healthy-replay`
- `npm run test:prune-batching`
- `npm run test:replay-ownership-guard`
- `npm run test:retention-admission-contract`
- `npm run test:runtime-bootstrap`
- `npm run test:replay-safety`

## Operational Harness

Run a local order-outage scenario with:

```bash
npm run harness:monitor -- --monitor-scenario monitor-order-outage --duration 10m --time-scale 60 --profile monitor-order-outage --run-name monitor-order-outage-10m-fast
```

The operational suites are:

- `npm run test:monitor-operational-smoke` — uses an 8-node default topology and a short scenario subset for CI and repeatable smoke confidence.
- `npm run test:monitor-operational-full` — uses an 8-node default topology and the broader monitor scenario set for production-shaped validation.

## Threshold Contract

`npm run test:http-thresholds-8nodes` runs a deterministic 8-node wall-clock simulation proving:

- order-only outage continues returning monitor decisions equivalent to HTTP `202 Accepted` after the `4h` rolling window while prune ages out old buffered rows
- dual outage continues returning monitor decisions equivalent to HTTP `202 Accepted` after the `6h` ceiling, with dead-lettering during prune rather than immediate ingress rejection
- true protective-stop behavior maps to HTTP `503 Service Unavailable` when dedupe-only bypass pressure crosses the hard backlog threshold

## Release Evidence

Tracked evidence for the overnight 8-node wall-clock dual-outage run is stored in:

- `validation/monitor-dual-outage-8h-wallclock-8nodes.json`
- `validation/monitor-dual-outage-8h-wallclock-8nodes.md`

# Performance Baselines

The repository benchmark is a comparative engineering signal, not a universal throughput claim or a production sizing guarantee. Results are meaningful only when the harness version, profile, package state, configuration, and host environment match closely.

## Commands

Run the standard baseline with:

```bash
npm run benchmark:monitor
```

This builds the package, performs one discarded warm-up and five measured samples for every case, and writes the detailed local report to the ignored `artifacts/validation/` directory. A release reviewer can retain a concise summary explicitly:

```bash
npm run benchmark:monitor -- --summary-output validation/monitor-v0.5.0-performance-baseline.json
```

The default CI contract runs the smaller correctness profile through `npm run test:performance-baseline-contract`. CI invalidates a report when a semantic assertion fails; it does not fail merely because an environment-specific timing moved.

## Workloads and boundaries

The baseline profile uses a fixed 256-character ASCII payload body plus event metadata, 200 operations or rows per applicable sample, batch size 32, concurrency 1, one fresh SQLite database per sample, and databases under the host OS temporary directory. All temporary databases are removed after the complete run.

The command covers:

- healthy ingress with capacity disabled and enabled below limits
- deterministic refusal after a one-row quota is saturated
- replay claim and acknowledgement through final drain
- bounded expired-pending and delivered-terminal pruning
- fresh startup and restart with persisted backlog
- raw, inspected, and operator-v1 snapshot reads
- scheduler interval pacing, retry-deadline scheduling, coalesced replay, health/prune cadence, cancellation, and shutdown
- lifecycle dispatch with no listener, fast listener, blocked slow listener, and controlled `drop_oldest` overflow

Setup and post-operation correctness assertions are excluded from the reported timing where the boundary is separable. Startup intentionally measures construction/reopen. Lifecycle measures publication through drain. Scheduler timing is secondary to its deterministic pacing and single-in-flight evidence.

## Validity and environment evidence

The report is written only after every case passes its correctness assertions. It records Node.js, npm, Node SQLite, OS/release, architecture, CPU, logical cores, total/free memory, filesystem capacity, temp-database placement, package and peer versions, configuration, commit identity, warm-up, sample count, and raw sample distributions. BigInt configuration is serialized as decimal strings.

Detailed sample output remains ignored. The tracked release summary omits raw samples but retains median, p95, minimum, maximum, median operations/second, low-rate evidence, workload identity, and correctness evidence.

## Regression review

Compare only matching profiles on the same class of host and storage. A candidate enters review when its median duration rises more than 25% or its p95 rises more than 35% from the accepted baseline. Repeat both baseline and candidate at least three times before treating that signal as a regression. Thermal throttling, host contention, antivirus scanning, low free memory, storage pressure, and power-state changes are reasons to invalidate and rerun noisy evidence.

The thresholds start an investigation; they do not waive correctness failures and do not automatically block a release. A reviewed change may update the retained baseline only with an explanation of the code, configuration, or environment change that accounts for the new distribution.

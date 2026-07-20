# Sustained-load and Soak Qualification

The v0.5.0 qualification runner extends the repository's existing eight-node combined-fault model with capacity refusal, lifecycle observer pressure, scheduler-owned replay, persisted retry timing, restart overlap, resource trends, shutdown timing, and final reopen verification.

These results are environment-specific operating envelopes. They are not universal throughput, latency, storage, or deployment guarantees.

## Reproduce the profiles

```bash
npm run test:monitor-phase6-smoke
npm run test:monitor-phase6-medium
npm run test:monitor-phase6-long
npm run test:monitor-phase6-sustained
```

Smoke models 20 minutes at 120×, medium models 2 hours at 240×, and long models an 8-hour horizon at 360×. These accelerated profiles exercise the complete scenario state machine but are not continuous wall-clock evidence. Sustained runs for 10 minutes at 1×. An explicit `wallclock` profile remains available for an 8-hour release-host burn-in.

Detailed samples and timelines are written under ignored `artifacts/validation/`. Tracked summaries in `validation/` omit raw samples while retaining the environment, artifact/configuration identity, counters, maxima, stable resource-window analysis, phase outcomes, scheduler/retry evidence, restart/shutdown timings, final state, and SQLite integrity result.

## Scenario and correctness boundary

Every profile uses eight source nodes and covers healthy flow, extended causal-order outage, reconnect burst, full downstream outage, injected replay failure, persisted per-row retry wait, a second outage/recovery cycle, slow and failing lifecycle observers, restart with backlog and observer pressure, continued live ingress during drain, and final recovery.

A report passes only when:

- every generated emission is eventually accepted exactly once or remains upstream-owned until it can be accepted;
- configured refusal persists no extra row and accepted pending rows are never evicted;
- all generated unique events reach the simulated order sink with no per-node sequence regression;
- replay traverses dedupe, the exact injected failed row does not replay before its stored deadline, and scheduler errors remain empty;
- restart preserves the quiescent pending-row count and retry state;
- slow, sync-throwing, and async-rejecting observers produce bounded visible drops/failures without affecting recovery;
- final upstream and monitor queues are empty, replay is idle, shutdown is bounded, SQLite `quick_check` is `ok`, and a fresh owner reopens the drained reservoir;
- heap, RSS, active handles, WAL, and logical pending usage stay inside the recorded envelope.

## Retained v0.5.0 envelopes

All profiles ran on the environment recorded inside their machine-readable summaries. The retained qualification reports were captured before the final metadata transition, so they identify package metadata `0.4.0` plus the cumulative implementation later published as `v0.5.0`. The summaries are historical measurements supporting the published `v0.5.0` package; they are not measurements of a registry-installed tarball.

| Profile | Horizon / wall time | Generated | Refusal attempts | Replayed through dedupe | Pending-row peak | Heap stable-window growth | Active-handle growth |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| smoke | 20m at 120× / 11.4s | 2,395 | 2,103 | 2,231 | 96 / 96 | +1.1 MiB | 0 |
| medium | 2h at 240× / 33.9s | 7,194 | 6,395 | 6,619 | 192 / 192 | +4.9 MiB | 0 |
| long horizon | 8h at 360× / 80.1s | 14,394 | 12,071 | 13,246 | 256 / 256 | +9.3 MiB | 0 |
| sustained | 10m at 1× / 600.1s | 1,199 | 243 | 534 | 96 / 96 | -0.7 MiB | 0 |

Across the retained runs, WAL stayed near 4 MiB, scheduler errors were zero, the observer queue reached its configured bound and reported controlled drops, final backlog was zero, and `quick_check` passed. The 1× run shut down in about 7.5 ms and reopened in about 16.9 ms on the recorded host.

Unchanged heartbeat observations now refresh in-memory health without appending false transition history, and identical replay snapshots are not persisted repeatedly after confirmation saturates. As a result, every retained run ended with 14 health-transition rows. Replay-session rows scale with actual replay progress rather than scheduler tick count.

Database growth during these profiles is explained by retained delivered ingress rows plus actual replay and health history. Terminal retention did not elapse, so a shrinking database was not expected. WAL, heap, RSS, active handles, logical usage, and auxiliary-row relationships remained bounded by the recorded workload.

## Deployment sizing equations

Start with deployment measurements, not the repository rates:

```text
required pending rows ≈ peak accepted ingress events/second × maximum outage seconds
required logical pending bytes ≈ required pending rows × measured serialized event bytes at a chosen percentile
net replay drain events/second = sustained replay events/second - concurrent buffered ingress events/second
estimated recovery seconds ≈ backlog rows / net replay drain events/second
```

Net replay drain must be positive. Include retry/reconnect bursts and safety margin when choosing `maxPendingRows` and `maxPendingSerializedBytes`. The serialized-event limit covers the complete persisted event envelope, not only `event.payload`.

Logical bytes exclude SQLite pages, indexes, retained terminal rows, replay/health history, WAL, filesystem allocation, backups, and maintenance headroom. Measure database and WAL amplification with representative payloads and fault cycles, then provision local storage above that result plus the configured filesystem resume reserve, backup/restore space, and an operator margin. Filesystem reserve is an admission guard, not a disk-sizing substitute.

If the estimated recovery time violates the service objective, increase measured replay capacity, reduce accepted outage backlog, or alter the deployment architecture. Do not assume the repository's simulated handler rate represents a real dedupe/order stack or storage device.

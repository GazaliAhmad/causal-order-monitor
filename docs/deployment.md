# Deployment Guide

`@causal-order/monitor` is bounded, single-owner recovery infrastructure. Deploy it with a host-local writable SQLite path and capacity for the worst credible downstream outage.

## Storage Placement

Use a service-owned local path such as `/var/lib/causal-order-monitor/monitor.sqlite`. Avoid read-only mounts, NFS, SMB, synced cloud folders, and other shared or network-backed filesystems for the live database unless their SQLite locking and durability behavior has been independently validated.

Only one live runtime or adapter process may own a reservoir. The adapter's operation guard is not a cross-process lock, distributed lease, or leader-election mechanism. Stop and close the owner before backup, restore, relocation, or restart, then reopen under exactly one owner.

## Deep-Outage Disk I/O Sizing

During `full_outage_buffer`, accepted ingress is persisted into SQLite, so peak ingress may become sustained local write pressure for hours. Plan storage and throughput around the outage worst case, not the healthy-path average.

### Minimum Raw Event-Volume Estimate

For the default six-hour hard-outage horizon, start with:

```text
peak accepted events/sec * average stored event bytes * 21,600 seconds
```

At 1,000 accepted events per second and 1 KB per event, the unadjusted payload estimate is about 21.6 GB.

This is not a storage capacity floor. Add measured headroom for SQLite metadata, indexes, journaling, filesystem slack, backups, continued ingress during replay, and recovery overlap.

### Throughput and Media

- Size for peak accepted writes across the full rolling-to-hard-outage window.
- Include journal, checkpoint, indexed-write, prune, and filesystem overhead.
- Prefer local SSD-class storage such as NVMe or provisioned SSD volumes.
- Leave headroom for prune work, recovery replay, and other host processes.
- Account for reconnect bursts and node jitter above long-run average ingress.

The monitor has been validated with representative 1 KiB, 64 KiB, and 1 MiB payloads, but those are compatibility examples rather than a universal size or throughput guarantee. Set `reservoir.capacity.maxSerializedEventBytes`, `maxPendingRows`, and `maxPendingSerializedBytes` from measured ingress, outage duration, storage, and replay capacity. Configure `filesystemReserve.minimumAvailableBytes` below a higher `resumeAvailableBytes` threshold when early low-space refusal is appropriate, and choose explicitly whether unavailable evidence permits logical admission or refuses it. The reserve is advisory: retain host alerts and handling for actual SQLite storage failures.

## Prune and Recovery Overlap

The hard retention ceiling does not immediately reject all ingress merely because old rows reached the maximum window. Routing still determines acceptance, while pruning marks expired pending rows `dead_letter` in indexed, bounded batches.

Large expiry cliffs can create background write spikes. Leaving at least 20% I/O headroom for prune and live-ingress overlap is a deployment guideline, not a package guarantee.

Watch for:

- database growth beyond expected backlog calculations
- backlog age growing faster than recovery can drain it
- host disk queuing, latency spikes, or noisy-neighbor contention
- pruning or replay overlapping continued recovery ingress
- database and WAL size, checkpoint results, and filesystem available bytes

If the host cannot sustain the write profile, correctness semantics may remain intact while the deployment becomes operationally fragile.

## Security and Data Handling

Payloads are stored in the primary database and may also appear in WAL pages and backups. The monitor does not encrypt or redact them. Applications must exclude secrets that should not be persisted and apply suitable filesystem, backup, and volume encryption.

See [persistence operations](persistence-operations.md) for WAL, backup, restore, failure, and compaction procedures, and the [operator runbook](operator-runbook.md) for incident response.

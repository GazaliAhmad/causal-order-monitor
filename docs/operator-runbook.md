# Monitor Operator Runbook

Use `MonitorRuntime.getOperatorSnapshot()` or `TransportMonitorAdapter.getOperatorSnapshot()` as the machine-readable source for these procedures. Require `schema === "causal-order-monitor/operator-snapshot"` and `version === 1` before interpreting the snapshot.

## Healthy and degraded live flow

- `status: "healthy"` and `recommendedAction: "none"` require no monitor intervention.
- `status: "degraded"` means live flow remains available but one or more entries in `affectedComponents` are not online.
- Restore the listed component and watch the status through recovery. Do not start manual replay on an adapter-managed runtime.

## Outage with contained buffering

`admission.posture: "accepted_buffered"`, `accepted: true`, and `httpStatus: 202` mean the event was accepted into SQLite but not forwarded normally. The snapshot status is normally `buffering` and the recommended action is `restore_affected_components`.

1. Restore the components listed in `affectedComponents`.
2. Preserve the SQLite database and its WAL sidecars.
3. Watch `backlog.totalRows`, `backlog.oldestAgeMs`, and storage pressure.
4. Allow configured health confirmation and replay orchestration to run.

Do not translate contained buffering to HTTP 503 or 429.

## Protective refusal

`admission.posture: "protective_refusal"`, `accepted: false`, and `httpStatus: 503` mean new work must not be treated as persisted. Adapter ingress throws `MonitorAdmissionRefusedError` before append.

The corresponding recommended action is `relieve_protective_pressure`.

1. Return 503 at an HTTP boundary.
2. Do not acknowledge the source event.
3. Correct the affected component, backlog pressure, or protective throttle condition.
4. Retry only after admission reopens.

## Retry waiting

`status: "recovering"` with `recommendedAction: "wait_for_retry"` means replay is in a persisted backoff window.

1. Inspect `replay.nextRetryAtMs`, `replay.retryDelayMs`, and `replay.consecutiveFailureCount`.
2. Keep live flow gated when `replay.gateClosed` is true.
3. When the retry deadline passes before replay resumes, expect `status: "attention_required"` with `recommendedAction: "inspect_replay_failure"`; the recovery gate remains closed and new accepted work remains buffered.
3. Correct the last known downstream fault, then wait until the deadline rather than starting competing replay control.

## Active replay and recovery confirmation

`recommendedAction: "monitor_replay"` covers queued/running replay and recovery-confirmation gates.

1. Track `replay.backlogRemainingRows`, `deliveredEventCount`, and `progressPercent`.
2. Confirm dedupe and causal-order remain online.
3. Keep the single runtime replay owner unchanged.
4. Treat a temporarily closed gate as recovery protection, not data loss.

## Terminal replay failure

`status: "attention_required"` with `recommendedAction: "inspect_replay_failure"` means replay is failed or aborted.

1. Inspect downstream health and retained replay error evidence.
2. Preserve pending and dead-letter rows.
3. Correct the external failure before retrying through the existing replay owner.
4. Do not edit replay state directly in SQLite.

## Storage pressure

`storage.pressure` reports bounded filesystem metadata: `critical` at exactly 5% or less available, `elevated` above 5% through exactly 15%, `normal` above 15%, and `unknown` when facts are unavailable or invalid. Classification uses the filesystem byte counts directly; `filesystemUsedPercent` is display evidence and is not fed back into threshold classification.

1. Track `databaseBytes`, `walBytes`, and `filesystemAvailableBytes` as decimal strings.
2. At `elevated`, investigate growth, retention, and checkpoint health.
3. At `critical`, stop avoidable load, expand or free the same local filesystem safely, and preserve database sidecars.
4. Never delete a live WAL file to recover space.
5. For `unknown`, use host monitoring under the deployment service account.

## Storage failure and corruption

- Busy/locked: remove the unexpected writer or long transaction, then retry.
- Full or read-only: restore writable capacity before retrying.
- WAL I/O: stop restart loops and preserve the database plus sidecars.
- Corrupt/incompatible: fail closed, preserve the original, and recover from a verified backup or qualified tooling on a copy.

Use `classifyMonitorBoundaryFailure()` for stable application routing. Unknown failures remain unclassified and require their original evidence.

## Restart recovery

1. Start exactly one monitor writer against the preserved local database.
2. Verify schema compatibility.
3. Read the v1 operator snapshot.
4. Allow interrupted replay claims to be reclaimed and normal recovery confirmation to complete.
5. Reopen live flow only when admission and gate evidence permit it.

## Indeterminate adapter completion

`MonitorIndeterminateOutcomeError` means monitor persistence succeeded but later delivery or acknowledgement did not complete observably.

1. Do not assume the row was absent or delivered.
2. Use `rowId` and the monitor reservoir as recovery authority.
3. Reopen/reconcile through normal replay and dedupe.
4. Do not blindly reinsert the event as a new identity.

## Shutdown

`MonitorClosedError` is a definite rejection of new work after shutdown. Close is idempotent. If shutdown overlaps an already persisted adapter event, the adapter may instead report an indeterminate outcome; preserve and reconcile the database on restart.

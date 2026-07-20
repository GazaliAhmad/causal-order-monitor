import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = {
  smoke: "validation/monitor-v0.5.0-phase6-smoke.json",
  medium: "validation/monitor-v0.5.0-phase6-medium.json",
  long: "validation/monitor-v0.5.0-phase6-long.json",
  sustained: "validation/monitor-v0.5.0-phase6-sustained-10m.json",
};

for (const [profile, file] of Object.entries(files)) {
  const report = JSON.parse(readFileSync(resolve(file), "utf8"));
  assert.equal(report.schema, "causal-order-monitor/phase6-soak-validation");
  assert.equal(report.version, 1);
  assert.equal(report.status, "passed");
  assert.equal(report.configuration.profile, profile);
  assert.equal(Object.hasOwn(report, "samples"), false);
  assert.equal(report.counters.acceptedByMonitor, report.counters.generatedEmissions);
  assert.equal(report.counters.orderUniqueEvents, report.counters.generatedUniqueEvents);
  assert.equal(report.counters.orderSequenceRegressions, 0);
  assert.ok(report.counters.capacityRefusalAttempts > 0);
  assert.equal(report.counters.upstreamRetryAttempts, report.counters.upstreamQueued);
  assert.ok(report.counters.replayDeliveriesThroughDedupe > 0);
  assert.equal(report.counters.replayInjectedFailures, 1);
  assert.equal(report.counters.restarts, 1);
  assert.equal(report.final.upstreamQueue, 0);
  assert.equal(report.final.operator.backlog.totalRows, 0);
  assert.equal(report.final.operator.replay.state, "idle");
  assert.equal(report.final.database.integrity, "ok");
  assert.ok(report.maxima.pendingRows <= report.configuration.capacityRows);
  assert.ok(report.maxima.lifecycleDroppedTotal > 0);
  assert.ok(report.maxima.lifecycleListenerFailureTotal > 0);
  assert.deepEqual(report.scheduler.errors, []);
  assert.ok(BigInt(report.retry.firstSuccessfulReplayAtMs) >= BigInt(report.retry.persistedDeadlineMs));
  assert.ok(Object.values(report.resourceAnalysis.conclusions).every(Boolean));
  assert.ok(report.final.database.counts.component_health_log <= 20);
  assert.ok(report.final.database.counts.replay_sessions < report.counters.replayDeliveriesThroughDedupe);
}

const sustained = JSON.parse(readFileSync(resolve(files.sustained), "utf8"));
assert.equal(sustained.configuration.timeScale, 1);
assert.ok(sustained.timing.wallElapsedMs >= 600_000);
assert.equal(sustained.scope, "continuous wall-clock qualification");

const long = JSON.parse(readFileSync(resolve(files.long), "utf8"));
assert.equal(long.configuration.duration, "8h");
assert.ok(long.scope.startsWith("accelerated long-horizon"));

console.log("Phase 6 soak summary contract passed: four retained profiles preserve capacity, ownership, replay, retry, lifecycle, resource, shutdown, integrity, and scope evidence.");

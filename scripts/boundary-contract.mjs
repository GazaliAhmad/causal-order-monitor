import assert from "node:assert/strict";

import {
  MonitorBoundaryError,
  MonitorClosedError,
  MonitorCapacityRefusedError,
  MonitorIndeterminateOutcomeError,
  MonitorRuntime,
  classifyMonitorBoundaryFailure,
} from "../.build/src/index.js";

const cases = [
  [new Error("database is locked"), "ERR_MONITOR_STORAGE_BUSY", true],
  [new Error("database or disk is full"), "ERR_MONITOR_STORAGE_FULL", true],
  [new Error("attempt to write a readonly database"), "ERR_MONITOR_STORAGE_READ_ONLY", true],
  [new Error("disk I/O error"), "ERR_MONITOR_STORAGE_IO", false],
];
for (const [error, code, retryable] of cases) {
  const failure = classifyMonitorBoundaryFailure(error, "append an event");
  assert.equal(failure.code, code);
  assert.equal(failure.outcome, "definite_rejection");
  assert.equal(failure.retryable, retryable);
  assert.doesNotThrow(() => JSON.stringify(failure));
}
assert.equal(classifyMonitorBoundaryFailure(new Error("application failure")), null);

const capacityRefusal = new MonitorCapacityRefusedError({
  limitingDimension: "pending_rows",
  reasonCode: "MONITOR_CAPACITY_PENDING_ROWS",
  limit: 10,
  current: 10,
  attempted: 11,
});
assert.equal(capacityRefusal.code, "ERR_MONITOR_CAPACITY_REFUSED");
assert.equal(capacityRefusal.httpStatus, 503);
assert.equal(capacityRefusal.recommendedAction, "retry_when_capacity_available");
assert.deepEqual(classifyMonitorBoundaryFailure(capacityRefusal), capacityRefusal.toJSON());

const runtime = new MonitorRuntime({ reservoir: { databasePath: ":memory:" } });
runtime.close();
assert.throws(
  () => runtime.getSnapshot(),
  (error) => {
    assert.ok(error instanceof MonitorClosedError);
    assert.ok(error instanceof MonitorBoundaryError);
    assert.equal(error.code, "ERR_MONITOR_CLOSED");
    assert.equal(error.outcome, "definite_rejection");
    assert.equal(error.retryable, false);
    return true;
  },
);

const indeterminate = new MonitorIndeterminateOutcomeError(
  "complete adapter ingress delivery",
  42,
  new Error("delivery acknowledgement connection lost"),
);
assert.equal(indeterminate.code, "ERR_MONITOR_OUTCOME_INDETERMINATE");
assert.equal(indeterminate.outcome, "indeterminate");
assert.equal(indeterminate.retryable, false);
assert.equal(indeterminate.recommendedAction, "reconcile_from_monitor_storage");
assert.equal(indeterminate.rowId, 42);
assert.doesNotThrow(() => JSON.stringify(indeterminate));

console.log(
  "boundary contract passed: logical capacity, contention, storage capacity, read-only, I/O, shutdown, and indeterminate outcomes have stable JSON-safe codes",
);

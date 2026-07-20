import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createDefaultMonitorConfig,
  MonitorCapacityRefusedError,
  MonitorClosedError,
  MonitorRuntime,
  resolveMonitorConfig,
  TransportMonitorAdapter,
} from "../.build/src/index.js";
import { SQLiteReservoir } from "../.build/src/storage.js";

const contract = JSON.parse(readFileSync(
  new URL("./fixtures/v0.5.0-capacity-lifecycle-contract.json", import.meta.url),
  "utf8",
));
const workspace = mkdtempSync(join(tmpdir(), "monitor-filesystem-reserve-"));
const defaults = createDefaultMonitorConfig();

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function event(id) {
  return {
    id,
    nodeId: "reserve-node",
    clock: { physicalTimeMs: 1_000n },
    payload: { fixture: "filesystem-reserve", id },
    ingestedAt: 1_000n,
  };
}

function storageEvidence(available) {
  if (available === null) {
    return {
      pressure: "unknown",
      databaseBytes: null,
      walBytes: null,
      filesystemAvailableBytes: null,
      filesystemTotalBytes: null,
      filesystemUsedPercent: null,
    };
  }
  return {
    pressure: "normal",
    databaseBytes: "4096",
    walBytes: "512",
    filesystemAvailableBytes: available.toString(),
    filesystemTotalBytes: "1000",
    filesystemUsedPercent: 50,
  };
}

function reservoir(name, reserve, readEvidence, logical = {}) {
  return new SQLiteReservoir(
    {
      ...defaults.reservoir,
      databasePath: join(workspace, name),
      capacity: {
        ...defaults.reservoir.capacity,
        ...logical,
        filesystemReserve: reserve,
      },
    },
    () => 50_000n,
    readEvidence,
  );
}

function append(target, id) {
  return target.appendIngressEvent(event(id), {
    sourcePath: "transport_normalized_stream",
    deliveryMode: "order_buffer_only",
  });
}

function assertReserveError(error, dimension, reason, action) {
  assert.ok(error instanceof MonitorCapacityRefusedError);
  assert.equal(error.httpStatus, 503);
  assert.equal(error.limitingDimension, dimension);
  assert.equal(error.reasonCode, reason);
  assert.equal(error.recommendedAction, action);
  return true;
}

try {
  const resolved = resolveMonitorConfig({
    reservoir: {
      capacity: {
        filesystemReserve: {
          minimumAvailableBytes: "100",
          resumeAvailableBytes: 200,
          unavailableEvidence: "allow_logical_admission",
        },
      },
    },
  });
  assert.deepEqual(resolved.reservoir.capacity.filesystemReserve, {
    minimumAvailableBytes: 100n,
    resumeAvailableBytes: 200n,
    unavailableEvidence: "allow_logical_admission",
  });
  for (const filesystemReserve of [
    {},
    { minimumAvailableBytes: "100", resumeAvailableBytes: "100", unavailableEvidence: "allow_logical_admission" },
    { minimumAvailableBytes: "100", resumeAvailableBytes: "99", unavailableEvidence: "allow_logical_admission" },
    { minimumAvailableBytes: null, resumeAvailableBytes: "200", unavailableEvidence: "allow_logical_admission" },
    { minimumAvailableBytes: "100", resumeAvailableBytes: "200", unavailableEvidence: "allow" },
    { minimumAvailableBytes: " 100", resumeAvailableBytes: "200", unavailableEvidence: "refuse_admission" },
  ]) {
    assert.throws(() => resolveMonitorConfig({
      reservoir: { capacity: { filesystemReserve } },
    }));
  }

  const reserve = {
    minimumAvailableBytes: 100n,
    resumeAvailableBytes: 200n,
    unavailableEvidence: "allow_logical_admission",
  };
  let available = 100n;
  const hysteresis = reservoir(
    "hysteresis.sqlite",
    reserve,
    () => storageEvidence(available),
  );
  assert.throws(
    () => append(hysteresis, "at-floor"),
    (error) => assertReserveError(
      error,
      "filesystem_reserve",
      "MONITOR_CAPACITY_FILESYSTEM_RESERVE",
      "free_local_storage_then_retry",
    ),
  );
  let snapshot = hysteresis.capacity.getSnapshot();
  assert.equal(snapshot.admission.posture, "refusing");
  assert.equal(snapshot.counters.refusedTotal, 1);
  assert.equal(snapshot.lastRefusal.limit, "100");
  available = 150n;
  assert.throws(() => append(hysteresis, "between-latched"), MonitorCapacityRefusedError);
  assert.equal(hysteresis.capacity.getSnapshot().lastRefusal.limit, "200");
  available = null;
  assert.throws(() => append(hysteresis, "unknown-latched"), (error) => {
    assert.equal(error.limitingDimension, "filesystem_reserve");
    assert.equal(error.limit, "200");
    assert.equal(error.current, "150");
    return true;
  });
  available = 200n;
  assert.equal(append(hysteresis, "at-resume"), 1);
  available = 150n;
  assert.equal(append(hysteresis, "between-open"), 2);
  snapshot = hysteresis.capacity.getSnapshot();
  assert.equal(snapshot.admission.posture, "open");
  assert.equal(snapshot.usage.pendingRows, 2);
  assert.equal(snapshot.usage.databaseBytes, "4096");
  assert.equal(snapshot.usage.walBytes, "512");
  assert.equal(snapshot.usage.filesystemAvailableBytes, "150");
  assert.equal(snapshot.counters.refusedTotal, 3);
  assert.equal(snapshot.counters.storageAppendFailureTotal, 0);
  assert.deepEqual(sortedKeys(snapshot), [...contract.capacity.snapshot.keys].sort());
  assert.deepEqual(
    sortedKeys(snapshot.admission),
    [...contract.capacity.snapshot.admissionKeys].sort(),
  );
  assert.deepEqual(sortedKeys(snapshot.limits), [...contract.capacity.snapshot.limitsKeys].sort());
  assert.deepEqual(sortedKeys(snapshot.usage), [...contract.capacity.snapshot.usageKeys].sort());
  assert.deepEqual(
    sortedKeys(snapshot.utilization),
    [...contract.capacity.snapshot.utilizationKeys].sort(),
  );
  assert.deepEqual(sortedKeys(snapshot.counters), [...contract.capacity.snapshot.counterKeys].sort());
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  hysteresis.close();
  assert.throws(() => hysteresis.capacity.getSnapshot(), MonitorClosedError);

  const unknownAllow = reservoir(
    "unknown-allow.sqlite",
    reserve,
    () => storageEvidence(null),
  );
  assert.equal(append(unknownAllow, "allowed-without-evidence"), 1);
  assert.deepEqual(unknownAllow.capacity.getSnapshot().admission, {
    posture: "unknown",
    reasonCode: "MONITOR_CAPACITY_FILESYSTEM_EVIDENCE_UNAVAILABLE",
    limitingDimension: "filesystem_evidence_unavailable",
  });
  unknownAllow.close();

  const unknownConservative = reservoir(
    "unknown-conservative.sqlite",
    { ...reserve, unavailableEvidence: "refuse_admission" },
    () => storageEvidence(null),
  );
  assert.throws(
    () => append(unknownConservative, "refused-without-evidence"),
    (error) => assertReserveError(
      error,
      "filesystem_evidence_unavailable",
      "MONITOR_CAPACITY_FILESYSTEM_EVIDENCE_UNAVAILABLE",
      "restore_capacity_evidence_then_retry",
    ),
  );
  assert.equal(unknownConservative.capacity.getSnapshot().admission.posture, "refusing");
  unknownConservative.close();

  const logicalSnapshot = reservoir(
    "logical-snapshot.sqlite",
    null,
    () => storageEvidence(500n),
    { maxPendingRows: 2 },
  );
  append(logicalSnapshot, "logical-one");
  assert.equal(logicalSnapshot.capacity.getSnapshot().utilization.pendingRowsPercent, 50);
  append(logicalSnapshot, "logical-two");
  assert.deepEqual(logicalSnapshot.capacity.getSnapshot().admission, {
    posture: "refusing",
    reasonCode: "MONITOR_CAPACITY_PENDING_ROWS",
    limitingDimension: "pending_rows",
  });
  logicalSnapshot.close();

  const failurePath = join(workspace, "storage-failure-counter.sqlite");
  const failureSeed = reservoir(
    "storage-failure-counter.sqlite",
    null,
    () => storageEvidence(500n),
  );
  failureSeed.close();
  const trigger = new DatabaseSync(failurePath);
  trigger.exec(`CREATE TRIGGER reject_ingress_append
    BEFORE INSERT ON ingress_events
    BEGIN SELECT RAISE(ABORT, 'injected storage append failure'); END`);
  trigger.close();
  const failureReservoir = reservoir(
    "storage-failure-counter.sqlite",
    null,
    () => storageEvidence(500n),
  );
  assert.throws(() => append(failureReservoir, "storage-failure"), /injected storage append failure/);
  assert.deepEqual(failureReservoir.capacity.getSnapshot().counters, {
    refusedTotal: 0,
    storageAppendFailureTotal: 1,
  });
  failureReservoir.close();

  const runtime = new MonitorRuntime({ reservoir: { databasePath: ":memory:" } });
  assert.equal(runtime.capacity.getSnapshot().schema, contract.capacity.snapshot.schema);
  assert.equal(runtime.capacity.getSnapshot().version, 1);
  const operatorKeys = sortedKeys(runtime.getOperatorSnapshot());
  assert.deepEqual(operatorKeys, contract.compatibility.operatorSnapshotShapeUnchanged
    ? ["admission", "affectedComponents", "backlog", "generatedAtMs", "recommendedAction", "replay", "routingMode", "schema", "status", "storage", "throttleTier", "version"].sort()
    : operatorKeys);
  runtime.close();

  const adapter = new TransportMonitorAdapter(
    { deliverToDedupe() {}, deliverToOrder() {} },
    { reservoir: { databasePath: ":memory:" } },
  );
  assert.equal(adapter.capacity, adapter.getRuntime().capacity);
  assert.equal(adapter.capacity.getSnapshot().schema, contract.capacity.snapshot.schema);
  adapter.close();

  const planDb = new DatabaseSync(join(workspace, "logical-snapshot.sqlite"), { readOnly: true });
  const plan = planDb.prepare(
    "EXPLAIN QUERY PLAN SELECT pending_rows, pending_serialized_bytes FROM reservoir_capacity_state WHERE singleton_id = 1",
  ).all().map((row) => String(row.detail)).join(" ");
  planDb.close();
  assert.match(plan, /INTEGER PRIMARY KEY|SEARCH reservoir_capacity_state/i);
  assert.doesNotMatch(plan, /ingress_events/i);

  console.log(
    "filesystem reserve and capacity snapshot passed: thresholds, hysteresis, unknown evidence, latching, bounded inspection, refusal/storage counters, facets, and operator-v1 compatibility are protected",
  );
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

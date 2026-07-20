import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  classifyMonitorBoundaryFailure,
  createDefaultMonitorConfig,
  MonitorCapacityRefusedError,
  MonitorRuntime,
  resolveMonitorConfig,
  TransportMonitorAdapter,
} from "../.build/src/index.js";
import * as runtimeModule from "../.build/src/runtime.js";
import * as transportModule from "../.build/src/transport.js";

const workspace = mkdtempSync(join(tmpdir(), "monitor-logical-capacity-"));

function event(id = "capacity-event") {
  return {
    id,
    nodeId: "capacity-node",
    clock: { physicalTimeMs: 1_000n, logicalCounter: 7n },
    sequence: 9n,
    traceId: "capacity-trace",
    payload: { text: "多字节🙂", amount: 12345678901234567890n },
    ingestedAt: 1_000n,
  };
}

function runtime(databaseName, capacity = {}) {
  return new MonitorRuntime({
    now: () => 10_000n,
    reservoir: {
      databasePath: join(workspace, databaseName),
      capacity: {
        ...createDefaultMonitorConfig().reservoir.capacity,
        ...capacity,
      },
    },
  });
}

function databaseSnapshot(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const accounting = db.prepare(
      "SELECT pending_rows, pending_serialized_bytes FROM reservoir_capacity_state WHERE singleton_id = 1",
    );
    accounting.setReadBigInts(true);
    const count = db.prepare("SELECT COUNT(*) AS count FROM ingress_events");
    count.setReadBigInts(true);
    return { ...accounting.get(), rowCount: count.get().count };
  } finally {
    db.close();
  }
}

function storedEventBytes(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = db.prepare(
      "SELECT serialized_event_bytes FROM ingress_events ORDER BY rowid LIMIT 1",
    );
    statement.setReadBigInts(true);
    return statement.get().serialized_event_bytes;
  } finally {
    db.close();
  }
}

function assertCapacityError(error, expected) {
  assert.ok(error instanceof MonitorCapacityRefusedError);
  assert.equal(error.code, "ERR_MONITOR_CAPACITY_REFUSED");
  assert.equal(error.httpStatus, 503);
  assert.equal(error.outcome, "definite_rejection");
  assert.equal(error.limitingDimension, expected.dimension);
  assert.equal(error.reasonCode, expected.reasonCode);
  assert.equal(error.recommendedAction, expected.action);
  assert.equal(error.retryable, expected.retryable);
  assert.doesNotThrow(() => JSON.stringify(error.toJSON()));
  assert.deepEqual(classifyMonitorBoundaryFailure(error), error.toJSON());
  return true;
}

try {
  const defaults = createDefaultMonitorConfig();
  assert.deepEqual(defaults.reservoir.capacity, {
    maxSerializedEventBytes: null,
    maxPendingRows: null,
    maxPendingSerializedBytes: null,
    filesystemReserve: null,
    overflowPolicy: "reject_new",
  });

  const parsed = resolveMonitorConfig({
    reservoir: {
      capacity: {
        maxSerializedEventBytes: "9007199254740993",
        maxPendingRows: 0,
        maxPendingSerializedBytes: 25,
        filesystemReserve: null,
        overflowPolicy: "reject_new",
      },
    },
  });
  assert.deepEqual(parsed.reservoir.capacity, {
    maxSerializedEventBytes: 9007199254740993n,
    maxPendingRows: 0,
    maxPendingSerializedBytes: 25n,
    filesystemReserve: null,
    overflowPolicy: "reject_new",
  });
  for (const capacity of [
    { maxSerializedEventBytes: "1KB" },
    { maxSerializedEventBytes: " 1" },
    { maxSerializedEventBytes: -1 },
    { maxSerializedEventBytes: 1.5 },
    { maxSerializedEventBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxPendingRows: "1" },
    { maxPendingRows: -1 },
    { maxPendingRows: 1.5 },
    { maxPendingSerializedBytes: "+1" },
    { overflowPolicy: "evict_oldest" },
    { filesystemReserve: { minimumAvailableBytes: "1" } },
  ]) {
    assert.throws(() => resolveMonitorConfig({ reservoir: { capacity } }));
  }
  for (const [index, capacity] of [
    { maxSerializedEventBytes: -1n },
    { maxSerializedEventBytes: 1 },
    { maxPendingRows: Number.MAX_SAFE_INTEGER + 1 },
    { maxPendingSerializedBytes: -1n },
    { overflowPolicy: "evict_oldest" },
    { filesystemReserve: {} },
  ].entries()) {
    assert.throws(() => runtime(`invalid-programmatic-${index}.sqlite`, capacity));
  }

  const measurementPath = join(workspace, "measurement.sqlite");
  const measurement = runtime("measurement.sqlite");
  measurement.ingestTransportEvent(event());
  const exactBytes = storedEventBytes(measurementPath);
  measurement.close();
  assert.ok(exactBytes > 0n);

  const exactPath = join(workspace, "event-exact.sqlite");
  const exact = runtime("event-exact.sqlite", {
    maxSerializedEventBytes: exactBytes,
  });
  assert.equal(exact.ingestTransportEvent(event()).rowId, 1);
  exact.close();
  assert.equal(databaseSnapshot(exactPath).rowCount, 1n);

  const oversizedPath = join(workspace, "event-oversized.sqlite");
  const oversized = runtime("event-oversized.sqlite", {
    maxSerializedEventBytes: exactBytes - 1n,
  });
  assert.throws(
    () => oversized.ingestTransportEvent(event()),
    (error) => {
      assertCapacityError(error, {
        dimension: "serialized_event_bytes",
        reasonCode: "MONITOR_CAPACITY_SERIALIZED_EVENT_BYTES",
        action: "reduce_event_size",
        retryable: false,
      });
      assert.equal(error.limit, (exactBytes - 1n).toString());
      assert.equal(error.current, "0");
      assert.equal(error.attempted, exactBytes.toString());
      return true;
    },
  );
  assert.deepEqual(databaseSnapshot(oversizedPath), {
    pending_rows: 0n,
    pending_serialized_bytes: 0n,
    rowCount: 0n,
  });
  oversized.close();

  const rowPath = join(workspace, "row-limit.sqlite");
  const rowLimited = runtime("row-limit.sqlite", { maxPendingRows: 1 });
  const firstRow = rowLimited.ingestTransportEvent(event("row-one")).rowId;
  assert.equal(firstRow, 1);
  assert.throws(
    () => rowLimited.ingestTransportEvent(event("row-two")),
    (error) => {
      assertCapacityError(error, {
        dimension: "pending_rows",
        reasonCode: "MONITOR_CAPACITY_PENDING_ROWS",
        action: "retry_when_capacity_available",
        retryable: true,
      });
      assert.equal(error.limit, "1");
      assert.equal(error.current, "1");
      assert.equal(error.attempted, "2");
      return true;
    },
  );
  assert.equal(databaseSnapshot(rowPath).rowCount, 1n);
  rowLimited.acknowledgeIngressDelivery([firstRow]);
  assert.equal(rowLimited.ingestTransportEvent(event("row-two")).rowId, 2);
  rowLimited.close();

  const zeroPath = join(workspace, "zero-row-limit.sqlite");
  const zeroRows = runtime("zero-row-limit.sqlite", { maxPendingRows: 0 });
  assert.throws(
    () => zeroRows.ingestTransportEvent(event("pending-refused")),
    MonitorCapacityRefusedError,
  );
  assert.equal(zeroRows.observeDedupeEvent(event("terminal-accepted")), 1);
  zeroRows.close();
  assert.deepEqual(databaseSnapshot(zeroPath), {
    pending_rows: 0n,
    pending_serialized_bytes: 0n,
    rowCount: 1n,
  });

  const bytePath = join(workspace, "byte-limit.sqlite");
  const byteLimited = runtime("byte-limit.sqlite", {
    maxPendingSerializedBytes: exactBytes,
  });
  const byteRow = byteLimited.ingestTransportEvent(event()).rowId;
  assert.throws(
    () => byteLimited.ingestTransportEvent(event()),
    (error) => {
      assertCapacityError(error, {
        dimension: "pending_serialized_bytes",
        reasonCode: "MONITOR_CAPACITY_PENDING_SERIALIZED_BYTES",
        action: "retry_when_capacity_available",
        retryable: true,
      });
      assert.equal(error.limit, exactBytes.toString());
      assert.equal(error.current, exactBytes.toString());
      assert.equal(error.attempted, (exactBytes * 2n).toString());
      return true;
    },
  );
  byteLimited.acknowledgeIngressDelivery([byteRow]);
  assert.equal(byteLimited.ingestTransportEvent(event()).rowId, 2);
  byteLimited.close();
  assert.equal(databaseSnapshot(bytePath).rowCount, 2n);

  const combined = runtime("combined.sqlite", {
    maxSerializedEventBytes: exactBytes,
    maxPendingRows: 0,
    maxPendingSerializedBytes: 0n,
  });
  assert.throws(
    () => combined.ingestTransportEvent(event()),
    (error) => {
      assert.equal(error.limitingDimension, "pending_rows");
      return true;
    },
  );
  combined.close();

  const concurrentPath = join(workspace, "concurrent.sqlite");
  const adapter = new TransportMonitorAdapter(
    { deliverToDedupe() {}, deliverToOrder() {} },
    {
      now: () => 20_000n,
      reservoir: {
        databasePath: concurrentPath,
        capacity: {
          ...defaults.reservoir.capacity,
          maxPendingRows: 1,
        },
      },
    },
  );
  adapter.updateComponentHealth("dedupe", {
    state: "offline",
    observedAt: 20_000n,
  });
  const concurrentResults = await Promise.allSettled([
    adapter.ingest(event("concurrent-one")),
    adapter.ingest(event("concurrent-two")),
  ]);
  assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = concurrentResults.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof MonitorCapacityRefusedError);
  assert.equal(databaseSnapshot(concurrentPath).rowCount, 1n);
  adapter.close();

  assert.equal(runtimeModule.MonitorCapacityRefusedError, MonitorCapacityRefusedError);
  assert.equal(transportModule.MonitorCapacityRefusedError, MonitorCapacityRefusedError);

  console.log(
    "logical capacity admission passed: disabled defaults, strict config, exact UTF-8/event/row/byte boundaries, stable 503 refusal, capacity release, and final-slot concurrency are protected",
  );
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

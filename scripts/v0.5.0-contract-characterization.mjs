import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as rootModule from "../.build/src/index.js";
import { createDefaultMonitorConfig, createMonitorRuntime } from "../.build/src/index.js";
import * as storageModule from "../.build/src/storage.js";
import { TransportMonitorAdapter } from "../.build/src/transport.js";

const contract = JSON.parse(readFileSync(
  new URL("./fixtures/v0.5.0-capacity-lifecycle-contract.json", import.meta.url),
  "utf8",
));
const expectUnimplemented = process.argv.includes("--expect-unimplemented");
const expectChunk3 = process.argv.includes("--expect-chunk-3");
const expectChunk4 = process.argv.includes("--expect-chunk-4");
const expectChunk5 = process.argv.includes("--expect-chunk-5");
const expectChunk6 = process.argv.includes("--expect-chunk-6");
const expectChunk7 = process.argv.includes("--expect-chunk-7");
const workspace = mkdtempSync(join(tmpdir(), "monitor-v050-contract-"));

function tableColumns(databasePath, tableName) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
  } finally {
    database.close();
  }
}

function tableExists(databasePath, tableName) {
  const database = new DatabaseSync(databasePath);
  try {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(tableName));
  } finally {
    database.close();
  }
}

try {
  const databasePath = join(workspace, "monitor.sqlite");
  const adapterDatabasePath = join(workspace, "adapter.sqlite");
  const defaults = createDefaultMonitorConfig();
  const runtime = createMonitorRuntime({ reservoir: { databasePath } });
  const adapter = new TransportMonitorAdapter(
    {
      deliverToDedupe() {},
      deliverToOrder() {},
    },
    { reservoir: { databasePath: adapterDatabasePath } },
  );

  try {
    const observed = {
      schemaVersion: storageModule.MONITOR_SQLITE_SCHEMA_VERSION,
      hasCapacityConfig: Object.hasOwn(defaults.reservoir, "capacity"),
      hasLifecycleConfig: Object.hasOwn(defaults, "lifecycle"),
      hasRuntimeCapacity: Object.hasOwn(runtime, "capacity") || "capacity" in runtime,
      hasRuntimeLifecycle: Object.hasOwn(runtime, "lifecycle") || "lifecycle" in runtime,
      hasAdapterCapacity: Object.hasOwn(adapter, "capacity") || "capacity" in adapter,
      hasAdapterLifecycle: Object.hasOwn(adapter, "lifecycle") || "lifecycle" in adapter,
      hasCapacityRefusedError: contract.capacity.refusalError.className in rootModule,
      hasCapacityAccountingError: contract.capacity.accountingError.className in storageModule,
      hasPerRowBytes: tableColumns(databasePath, "ingress_events").includes(
        contract.schema.perRowColumn,
      ),
      hasAggregateState: tableExists(databasePath, contract.schema.aggregateTable),
    };

    if (expectUnimplemented) {
      assert.deepEqual(observed, {
        schemaVersion: 2,
        hasCapacityConfig: false,
        hasLifecycleConfig: false,
        hasRuntimeCapacity: false,
        hasRuntimeLifecycle: false,
        hasAdapterCapacity: false,
        hasAdapterLifecycle: false,
        hasCapacityRefusedError: false,
        hasCapacityAccountingError: false,
        hasPerRowBytes: false,
        hasAggregateState: false,
      });
      console.log("v0.5.0 capacity/lifecycle contract: expected red baseline confirmed");
    } else if (expectChunk3) {
      assert.deepEqual(observed, {
        schemaVersion: contract.sqliteSchemaVersion,
        hasCapacityConfig: false,
        hasLifecycleConfig: false,
        hasRuntimeCapacity: false,
        hasRuntimeLifecycle: false,
        hasAdapterCapacity: false,
        hasAdapterLifecycle: false,
        hasCapacityRefusedError: false,
        hasCapacityAccountingError: true,
        hasPerRowBytes: true,
        hasAggregateState: true,
      });
      console.log(
        "v0.5.0 capacity/lifecycle contract: Chunk 3 accounting implemented; admission and lifecycle remain red",
      );
    } else if (expectChunk4) {
      assert.deepEqual(observed, {
        schemaVersion: contract.sqliteSchemaVersion,
        hasCapacityConfig: true,
        hasLifecycleConfig: false,
        hasRuntimeCapacity: false,
        hasRuntimeLifecycle: false,
        hasAdapterCapacity: false,
        hasAdapterLifecycle: false,
        hasCapacityRefusedError: true,
        hasCapacityAccountingError: true,
        hasPerRowBytes: true,
        hasAggregateState: true,
      });
      assert.deepEqual(defaults.reservoir.capacity, contract.capacity.defaults);
      console.log(
        "v0.5.0 capacity/lifecycle contract: Chunk 4 logical admission implemented; filesystem evidence, capacity facets, and lifecycle remain red",
      );
    } else if (expectChunk5) {
      assert.deepEqual(observed, {
        schemaVersion: contract.sqliteSchemaVersion,
        hasCapacityConfig: true,
        hasLifecycleConfig: false,
        hasRuntimeCapacity: true,
        hasRuntimeLifecycle: false,
        hasAdapterCapacity: true,
        hasAdapterLifecycle: false,
        hasCapacityRefusedError: true,
        hasCapacityAccountingError: true,
        hasPerRowBytes: true,
        hasAggregateState: true,
      });
      assert.deepEqual(defaults.reservoir.capacity, contract.capacity.defaults);
      assert.equal(adapter.capacity, adapter.getRuntime().capacity);
      assert.equal(runtime.capacity.getSnapshot().schema, contract.capacity.snapshot.schema);
      assert.equal(runtime.capacity.getSnapshot().version, contract.capacity.snapshot.version);
      console.log(
        "v0.5.0 capacity/lifecycle contract: Chunk 5 capacity implemented; lifecycle remains red",
      );
    } else {
      assert.equal(observed.schemaVersion, contract.sqliteSchemaVersion);
      for (const [name, value] of Object.entries(observed)) {
        if (name !== "schemaVersion") assert.equal(value, true, `${name} must be implemented`);
      }
      assert.deepEqual(defaults.reservoir.capacity, contract.capacity.defaults);
      assert.deepEqual(
        {
          ...defaults.lifecycle,
          shutdownFlushTimeoutMs: defaults.lifecycle.shutdownFlushTimeoutMs.toString(),
        },
        contract.lifecycle.defaults,
      );
      assert.equal(runtime.capacity.getSnapshot().schema, contract.capacity.snapshot.schema);
      assert.equal(runtime.capacity.getSnapshot().version, contract.capacity.snapshot.version);
      assert.equal(runtime.lifecycle.getSnapshot().schema, contract.lifecycle.snapshot.schema);
      assert.equal(runtime.lifecycle.getSnapshot().version, contract.lifecycle.snapshot.version);
      if (expectChunk7) {
        const lifecycleTypes = [];
        for (const eventName of contract.lifecycle.events) {
          adapter.lifecycle.subscribe(eventName, (event) => lifecycleTypes.push(event.type));
        }
        await adapter.ingest({
          id: "chunk-7-characterization",
          nodeId: "characterization-node",
          clock: { physicalTimeMs: 1n },
          payload: { entityId: "characterization" },
        });
        await adapter.lifecycle.flush();
        assert.deepEqual(
          lifecycleTypes.filter((type) => [
            "ingressAttempted",
            "ingressAccepted",
            "deliveryAttempted",
            "deliveryHandlerCompleted",
            "deliveryAcknowledged",
          ].includes(type)),
          [
            "ingressAttempted",
            "ingressAccepted",
            "deliveryAttempted",
            "deliveryHandlerCompleted",
            "deliveryAcknowledged",
          ],
        );
      }
      console.log(
        expectChunk7
          ? "v0.5.0 capacity/lifecycle contract: Chunk 7 truthful lifecycle instrumentation implemented"
          : expectChunk6
          ? "v0.5.0 capacity/lifecycle contract: Chunk 6 public lifecycle model implemented"
          : "v0.5.0 capacity/lifecycle contract: implemented contract confirmed",
      );
    }
  } finally {
    adapter.close();
    runtime.close();
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

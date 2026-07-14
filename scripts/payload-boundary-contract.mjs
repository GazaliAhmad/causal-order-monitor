import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLiteReservoir } from "../.build/src/storage.js";

const root = mkdtempSync(join(tmpdir(), "monitor-payload-boundary-"));
const databasePath = join(root, "payloads.sqlite");
const reservoir = new SQLiteReservoir(
  {
    databasePath,
    rollingBufferWindowMs: 100_000n,
    fullOutageMaxWindowMs: 200_000n,
    pruneIntervalMs: 1_000n,
    pruneBatchSize: 100,
  },
  () => 100_000n,
);
let sequence = 0;

function appendPayload(payload, id = `payload-${sequence}`) {
  sequence += 1;
  return reservoir.appendIngressEvent(
    {
      id,
      nodeId: "payload-node",
      clock: { physicalTimeMs: BigInt(sequence) },
      sequence: BigInt(sequence),
      payload,
      ingestedAt: BigInt(sequence),
    },
    {
      sourcePath: "transport_normalized_stream",
      deliveryMode: "order_buffer_only",
      monitorIngestAt: BigInt(sequence),
    },
  );
}

function claimOne() {
  const entries = reservoir.claimReplayBatch(1);
  assert.equal(entries.length, 1);
  return entries[0];
}

try {
  const ordinary = {
    text: "hello 🌏",
    number: 42.5,
    boolean: true,
    nil: null,
    array: [1, "two", false],
    nested: { value: "ok" },
    bigint: 9_007_199_254_740_993n,
  };
  appendPayload(ordinary, "ordinary");
  const ordinaryEntry = claimOne();
  assert.deepEqual(ordinaryEntry.event.payload, ordinary);
  reservoir.markReplayBatchDelivered([ordinaryEntry.rowId]);

  appendPayload({
    omitted: undefined,
    array: [undefined, 1],
    fn: () => "not serialized",
    symbol: Symbol("not serialized"),
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
  }, "json-semantics");
  const transformed = claimOne();
  assert.deepEqual(transformed.event.payload, {
    array: [null, 1],
    nan: null,
    positiveInfinity: null,
  });
  reservoir.markReplayBatchDelivered([transformed.rowId]);

  const literalSentinels = {
    legacyLooking: { __monitorBigInt: "123" },
    escapedLooking: {
      __causalOrderMonitorInternalEscapedJsonV1__: [["key", "value"]],
    },
  };
  appendPayload(literalSentinels, "literal-sentinels");
  const literalEntry = claimOne();
  assert.deepEqual(literalEntry.event.payload, literalSentinels);
  reservoir.markReplayBatchDelivered([literalEntry.rowId]);

  const beforeRejected = reservoir.getPendingRowCount();
  const cyclic = { name: "cycle" };
  cyclic.self = cyclic;
  assert.throws(() => appendPayload(cyclic, "cyclic"), /circular|cyclic/i);
  assert.equal(reservoir.getPendingRowCount(), beforeRejected);

  let deep = { leaf: true };
  for (let depth = 0; depth < 20_000; depth += 1) deep = { child: deep };
  assert.throws(() => appendPayload(deep, "too-deep"), /stack|recursion/i);
  assert.equal(reservoir.getPendingRowCount(), beforeRejected);

  const sizes = [1_024, 64 * 1_024, 1_024 * 1_024];
  for (const size of sizes) {
    appendPayload({ data: "x".repeat(size) }, `size-${size}`);
  }
  const sized = reservoir.claimReplayBatch(sizes.length);
  assert.deepEqual(
    sized.map((entry) => entry.event.payload.data.length),
    sizes,
  );
  reservoir.markReplayBatchDelivered(sized.map((entry) => entry.rowId));
  assert.equal(reservoir.getPendingRowCount(), 0);

  const legacyRowId = appendPayload({ placeholder: true }, "legacy-bigint");
  const legacyWriter = new DatabaseSync(databasePath);
  try {
    legacyWriter.prepare(
      "UPDATE ingress_events SET payload_json = ? WHERE rowid = ?",
    ).run(
      JSON.stringify({
        id: "legacy-bigint",
        nodeId: "payload-node",
        clock: { physicalTimeMs: { __monitorBigInt: "77" } },
        payload: { value: { __monitorBigInt: "9007199254740993" } },
        ingestedAt: { __monitorBigInt: "77" },
      }),
      legacyRowId,
    );
  } finally {
    legacyWriter.close();
  }
  const legacy = claimOne();
  assert.equal(legacy.event.clock.physicalTimeMs, 77n);
  assert.equal(legacy.event.payload.value, 9_007_199_254_740_993n);
  assert.equal(legacy.event.ingestedAt, 77n);
  reservoir.markReplayBatchDelivered([legacy.rowId]);
  assert.equal(reservoir.getPendingRowCount(), 0);

  console.log(
    "payload-boundary contract passed: JSON semantics, BigInt, literal sentinel keys, rejection-before-acceptance, and representative 1 KiB/64 KiB/1 MiB payloads are explicit",
  );
} finally {
  reservoir.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

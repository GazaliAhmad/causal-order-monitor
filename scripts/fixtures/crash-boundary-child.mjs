import { SQLiteReservoir } from "../../.build/src/storage.js";

const OPERATIONS = new Set([
  "append",
  "claim",
  "acknowledge",
  "retry-reset",
  "reclaim",
  "prune-mark",
  "prune-delete",
  "checkpoint-passive",
  "checkpoint-restart",
  "checkpoint-truncate",
  "close",
]);

function fail(message) {
  throw new Error(`crash-boundary child: ${message}`);
}

function parseScenario() {
  const encoded = process.argv[2];
  if (!encoded) fail("missing base64url scenario argument");

  let scenario;
  try {
    scenario = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    fail(`invalid scenario argument: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!scenario || typeof scenario !== "object") fail("scenario must be an object");
  if (typeof scenario.databasePath !== "string" || scenario.databasePath.length === 0) {
    fail("databasePath must be a non-empty string");
  }
  if (!OPERATIONS.has(scenario.operation)) {
    fail(`unsupported operation ${JSON.stringify(scenario.operation)}`);
  }
  if (!new Set(["before-operation", "after-operation"]).has(scenario.pausePoint)) {
    fail(`unsupported pausePoint ${JSON.stringify(scenario.pausePoint)}`);
  }
  if (typeof scenario.eventId !== "string" || scenario.eventId.length === 0) {
    fail("eventId must be a non-empty string");
  }
  return scenario;
}

function send(message) {
  if (typeof process.send !== "function") fail("an IPC channel is required");
  process.send(message);
}

function waitForResume(expectedGate) {
  return new Promise((resolve, reject) => {
    const onDisconnect = () => {
      cleanup();
      reject(new Error(`IPC disconnected while paused at ${expectedGate}`));
    };
    const onMessage = (message) => {
      if (message?.type !== "resume" || message?.gate !== expectedGate) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
    };
    process.on("disconnect", onDisconnect);
    process.on("message", onMessage);
  });
}

async function pause(gate) {
  send({ type: "gate", gate });
  await waitForResume(gate);
}

function event(id, monitorIngestAt) {
  return {
    id,
    nodeId: "crash-boundary-node",
    clock: { physicalTimeMs: monitorIngestAt },
    payload: { fixture: "crash-boundary", eventId: id },
    ingestedAt: monitorIngestAt,
  };
}

function append(reservoir, scenario, options = {}) {
  const monitorIngestAt = options.monitorIngestAt ?? BigInt(scenario.monitorIngestAtMs);
  return reservoir.appendIngressEvent(event(scenario.eventId, monitorIngestAt), {
    sourcePath: "transport_normalized_stream",
    deliveryMode: "order_buffer_only",
    monitorIngestAt,
    replayState: options.replayState ?? "pending",
  });
}

function prepareOperation(reservoir, scenario) {
  switch (scenario.operation) {
    case "append":
      return {};
    case "claim":
    case "checkpoint-passive":
    case "checkpoint-restart":
    case "checkpoint-truncate":
    case "close":
      return { rowId: append(reservoir, scenario) };
    case "acknowledge":
    case "retry-reset":
    case "reclaim": {
      const rowId = append(reservoir, scenario);
      const [claimed] = reservoir.claimReplayBatch(1);
      if (claimed?.rowId !== rowId) fail(`${scenario.operation} setup did not claim row ${rowId}`);
      return { rowId };
    }
    case "prune-mark":
      return { rowId: append(reservoir, scenario, { monitorIngestAt: 0n }) };
    case "prune-delete":
      return {
        rowId: append(reservoir, scenario, {
          monitorIngestAt: 0n,
          replayState: "delivered",
        }),
      };
    default:
      fail(`no setup for operation ${scenario.operation}`);
  }
}

function executeOperation(reservoir, scenario, setup) {
  switch (scenario.operation) {
    case "append":
      return { rowId: append(reservoir, scenario) };
    case "claim": {
      const entries = reservoir.claimReplayBatch(1);
      return {
        claimedRowIds: entries.map((entry) => entry.rowId),
        replayAttempts: entries.map((entry) => entry.replayAttempts),
      };
    }
    case "acknowledge":
      return { changedRows: reservoir.markReplayBatchDelivered([setup.rowId]) };
    case "retry-reset":
      return {
        changedRows: reservoir.resetReplayBatchToPending(
          [setup.rowId],
          BigInt(scenario.retryNotBeforeMs),
        ),
      };
    case "reclaim":
      return { changedRows: reservoir.reclaimStaleReplayRows(0n) };
    case "prune-mark":
    case "prune-delete":
      return { pruneResult: reservoir.pruneExpired(false) };
    case "checkpoint-passive":
      return { checkpoint: reservoir.checkpointWal("passive") };
    case "checkpoint-restart":
      return { checkpoint: reservoir.checkpointWal("restart") };
    case "checkpoint-truncate":
      return { checkpoint: reservoir.checkpointWal("truncate") };
    case "close":
      reservoir.close();
      return { closed: true };
    default:
      fail(`no execution for operation ${scenario.operation}`);
  }
}

const scenario = parseScenario();
const now = BigInt(scenario.nowMs);
let reservoir;

try {
  send({ type: "ready", operation: scenario.operation, pausePoint: scenario.pausePoint });
  await waitForResume("ready");

  reservoir = new SQLiteReservoir(
    {
      databasePath: scenario.databasePath,
      rollingBufferWindowMs: 100_000n,
      fullOutageMaxWindowMs: 200_000n,
      pruneIntervalMs: 1_000n,
      pruneBatchSize: 100,
      deliveredRetentionMs: 1_000n,
      deadLetterRetentionMs: 2_000n,
    },
    () => now,
  );

  const setup = prepareOperation(reservoir, scenario);
  if (scenario.pausePoint === "before-operation") await pause("before-operation");

  const result = executeOperation(reservoir, scenario, setup);
  if (scenario.operation === "close") reservoir = undefined;
  if (scenario.pausePoint === "after-operation") await pause("after-operation");

  send({
    type: "observed-result",
    operation: scenario.operation,
    result,
    pendingRows: reservoir?.getPendingRowCount() ?? null,
    schemaVersion: reservoir?.getSchemaInfo().currentVersion ?? 2,
  });
  reservoir?.close();
  reservoir = undefined;
  process.disconnect();
} catch (error) {
  send({
    type: "child-error",
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  try {
    reservoir?.close();
  } catch {
    // Preserve the original fixture failure.
  }
  process.exitCode = 1;
  process.disconnect();
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SQLiteReservoir } from "../.build/src/storage.js";

const fixturePath = fileURLToPath(new URL("./fixtures/crash-boundary-child.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "monitor-crash-boundary-"));
const NOW = 300_000n;
const INGEST = 250_000n;
const RETRY_AT = 305_000n;

const OPERATIONS = [
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
];

function encodeScenario(scenario) {
  return Buffer.from(JSON.stringify(scenario), "utf8").toString("base64url");
}

function inspectDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const journalMode = db.prepare("PRAGMA journal_mode").get().journal_mode;
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const statement = db.prepare(
      `SELECT
         rowid AS row_id,
         id,
         monitor_ingest_at_ms,
         replay_state,
         replay_attempts,
         retry_not_before_ms,
         replay_claimed_at_ms,
         terminal_at_ms
       FROM ingress_events
       ORDER BY monitor_ingest_at_ms ASC, rowid ASC`,
    );
    statement.setReadBigInts(true);
    return {
      schemaVersion: Number(version),
      journalMode,
      integrity,
      rows: statement.all().map((row) => ({
        rowId: Number(row.row_id),
        id: row.id,
        monitorIngestAtMs: row.monitor_ingest_at_ms,
        replayState: row.replay_state,
        replayAttempts: Number(row.replay_attempts),
        retryNotBeforeMs: row.retry_not_before_ms,
        replayClaimedAtMs: row.replay_claimed_at_ms,
        terminalAtMs: row.terminal_at_ms,
      })),
    };
  } finally {
    db.close();
  }
}

function inspectRestartRecovery(databasePath) {
  const reservoir = new SQLiteReservoir(
    {
      databasePath,
      rollingBufferWindowMs: 100_000n,
      fullOutageMaxWindowMs: 200_000n,
      pruneIntervalMs: 1_000n,
      pruneBatchSize: 100,
      deliveredRetentionMs: 1_000n,
      deadLetterRetentionMs: 2_000n,
    },
    () => NOW,
  );
  try {
    const restart = reservoir.recoverRestartState();
    const eligibleRowIds = reservoir.claimReplayBatch(100).map((entry) => entry.rowId);
    return {
      totalPendingRows: restart.totalPendingRows,
      retryWaitingRows: restart.retryWaitingRows,
      earliestRetryAt: restart.earliestRetryAt,
      reclaimedInterruptedRows: restart.reclaimedInterruptedRows,
      eligibleRowIds,
    };
  } finally {
    reservoir.close();
  }
}

function runScenario(scenario, actionAtPause) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, encodeScenario(scenario)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let observedResult = null;
    let requestedTermination = false;
    let settled = false;

    const watchdog = setTimeout(() => {
      child.kill();
      finish(new Error(`child timed out for ${scenario.operation}/${scenario.pausePoint}`));
    }, 10_000);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("message", (message) => {
      if (message?.type === "ready") {
        child.send({ type: "resume", gate: "ready" });
      } else if (message?.type === "gate" && message.gate === scenario.pausePoint) {
        if (actionAtPause === "terminate") {
          requestedTermination = true;
          child.kill();
        } else {
          child.send({ type: "resume", gate: message.gate });
        }
      } else if (message?.type === "observed-result") {
        observedResult = message;
      } else if (message?.type === "child-error") {
        finish(new Error(message.message));
      }
    });
    child.on("exit", (code, signal) => {
      if (requestedTermination) {
        assert.notEqual(signal, null, "terminated fixture should report a signal");
        finish(null, { code, signal, observedResult, stdout, stderr });
      } else if (code !== 0) {
        finish(new Error(`child exited ${code}: ${stderr || stdout}`));
      } else {
        finish(null, { code, signal, observedResult, stdout, stderr });
      }
    });
  });
}

function createScenario(operation, pausePoint, databasePath, suffix = pausePoint) {
  return {
    databasePath,
    operation,
    pausePoint,
    nowMs: NOW.toString(),
    monitorIngestAtMs: INGEST.toString(),
    retryNotBeforeMs: RETRY_AT.toString(),
    eventId: `${operation}-${suffix}`,
  };
}

function row(id, overrides = {}) {
  return {
    rowId: 1,
    id,
    monitorIngestAtMs: INGEST,
    replayState: "pending",
    replayAttempts: 0,
    retryNotBeforeMs: null,
    replayClaimedAtMs: null,
    terminalAtMs: null,
    ...overrides,
  };
}

function expectedRows(operation, phase, eventId) {
  if (operation === "append") return phase === "before-operation" ? [] : [row(eventId)];
  if (operation === "prune-mark") {
    return [row(eventId, {
      monitorIngestAtMs: 0n,
      replayState: phase === "after-operation" ? "dead_letter" : "pending",
      terminalAtMs: phase === "after-operation" ? NOW : null,
    })];
  }
  if (operation === "prune-delete") {
    return phase === "after-operation" ? [] : [row(eventId, {
      monitorIngestAtMs: 0n,
      replayState: "delivered",
      terminalAtMs: 0n,
    })];
  }
  if (operation === "claim") {
    return [row(eventId, phase === "after-operation" ? {
      replayState: "replaying",
      replayAttempts: 1,
      replayClaimedAtMs: NOW,
    } : {})];
  }
  if (["acknowledge", "retry-reset", "reclaim"].includes(operation)) {
    const claimed = {
      replayState: "replaying",
      replayAttempts: 1,
      replayClaimedAtMs: NOW,
    };
    if (phase === "before-operation") return [row(eventId, claimed)];
    if (operation === "acknowledge") {
      return [row(eventId, {
        replayState: "delivered",
        replayAttempts: 1,
        terminalAtMs: NOW,
      })];
    }
    if (operation === "retry-reset") {
      return [row(eventId, { replayAttempts: 1, retryNotBeforeMs: RETRY_AT })];
    }
    return [row(eventId, { replayAttempts: 1 })];
  }
  return [row(eventId)];
}

function expectedRecovery(rows) {
  const retryWaiting = rows.filter(
    (entry) => entry.replayState === "pending" &&
      entry.retryNotBeforeMs !== null &&
      entry.retryNotBeforeMs > NOW,
  );
  const recoverable = rows.filter(
    (entry) => entry.replayState === "pending" || entry.replayState === "replaying",
  );
  const eligible = recoverable.filter(
    (entry) => entry.retryNotBeforeMs === null || entry.retryNotBeforeMs <= NOW,
  );
  return {
    totalPendingRows: recoverable.length,
    retryWaitingRows: retryWaiting.length,
    earliestRetryAt: retryWaiting.length === 0
      ? null
      : retryWaiting.reduce(
          (minimum, entry) => minimum < entry.retryNotBeforeMs ? minimum : entry.retryNotBeforeMs,
          retryWaiting[0].retryNotBeforeMs,
        ),
    reclaimedInterruptedRows: rows.filter((entry) => entry.replayState === "replaying").length,
    eligibleRowIds: eligible.map((entry) => entry.rowId),
  };
}

function assertInspection(actual, expectedRowsForScenario, label) {
  assert.equal(actual.schemaVersion, 3, `${label}: schema version`);
  assert.equal(actual.journalMode, "wal", `${label}: journal mode`);
  assert.equal(actual.integrity, "ok", `${label}: integrity check`);
  assert.deepEqual(actual.rows, expectedRowsForScenario, `${label}: persisted rows`);
}

try {
  const controlPath = join(root, "control.sqlite");
  const controlScenario = createScenario("append", "after-operation", controlPath, "control");
  const control = await runScenario(controlScenario, "continue");
  assert.equal(control.code, 0);
  assert.deepEqual(control.observedResult, {
    type: "observed-result",
    operation: "append",
    result: { rowId: 1 },
    pendingRows: 1,
    schemaVersion: 3,
  });
  assertInspection(
    inspectDatabase(controlPath),
    expectedRows("append", "after-operation", controlScenario.eventId),
    "append/control",
  );
  assert.deepEqual(
    inspectRestartRecovery(controlPath),
    expectedRecovery(expectedRows("append", "after-operation", controlScenario.eventId)),
    "append/control: restart recovery",
  );

  const characterized = [];
  for (const operation of OPERATIONS) {
    for (const pausePoint of ["before-operation", "after-operation"]) {
      const databasePath = join(root, `${operation}-${pausePoint}.sqlite`);
      const testScenario = createScenario(operation, pausePoint, databasePath);
      const killed = await runScenario(testScenario, "terminate");
      assert.equal(killed.observedResult, null, `${operation}/${pausePoint}: caller result`);
      const rows = expectedRows(operation, pausePoint, testScenario.eventId);
      assertInspection(
        inspectDatabase(databasePath),
        rows,
        `${operation}/${pausePoint}`,
      );
      assert.deepEqual(
        inspectRestartRecovery(databasePath),
        expectedRecovery(rows),
        `${operation}/${pausePoint}: restart recovery`,
      );
      characterized.push(`${operation}/${pausePoint}`);
    }
  }

  assert.equal(characterized.length, OPERATIONS.length * 2);
  console.log(
    `crash-boundary characterization passed: built-package control plus ${characterized.length} forced-termination boundaries preserved schema v3, WAL recovery, integrity, exact row state, and restart replay eligibility`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

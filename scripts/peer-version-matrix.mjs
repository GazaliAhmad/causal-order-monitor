import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath = process.env.npm_execpath;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isWithin(parentPath, candidatePath) {
  const child = relative(parentPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function runNpm(args) {
  assert.ok(
    npmCliPath,
    "Run this contract through npm run test:peer-version-matrix so npm_execpath is available.",
  );
  const result = spawnSync(process.execPath, [npmCliPath, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(
    result.status,
    0,
    `npm ${args.join(" ")} should complete successfully`,
  );
}

function hashFile(path, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

const packageJson = readJson(join(repositoryRoot, "package.json"));
const matrix = readJson(
  join(repositoryRoot, "scripts/fixtures/v0.4.0-peer-matrix.json"),
);
assert.equal(matrix.schemaVersion, 1, "peer matrix schema version");
assert.equal(matrix.rows.length, 2, "peer matrix should contain minimum and range-latest rows");

const [minimumRow, rangeRow] = matrix.rows;
assert.equal(minimumRow.id, "minimum");
assert.equal(rangeRow.id, "declared-range-latest");
assert.deepEqual(rangeRow.versions, {
  transport: packageJson.peerDependencies["@causal-order/transport"],
  dedupe: packageJson.peerDependencies["@causal-order/dedupe"],
  causalOrder: packageJson.peerDependencies["causal-order"],
  testing: packageJson.devDependencies["@causal-order/testing"],
}, "range-latest row should track declared package ranges");

const workspace = mkdtempSync(join(tmpdir(), "causal-order-monitor-peer-matrix-"));
const artifactDirectory = join(workspace, "artifact");
mkdirSync(artifactDirectory, { recursive: true });
const artifactFilename = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
const artifactPath = join(artifactDirectory, artifactFilename);
let artifactSha512 = null;

try {
  for (const [index, row] of matrix.rows.entries()) {
    console.log(`Running peer matrix row ${row.id}: ${row.description}`);
    const args = [
      "run",
      "test:packed-artifact-consumer",
      "--",
      "--transport-version",
      row.versions.transport,
      "--dedupe-version",
      row.versions.dedupe,
      "--causal-order-version",
      row.versions.causalOrder,
      "--testing-version",
      row.versions.testing,
    ];

    if (index === 0) {
      args.push("--pack-destination", artifactDirectory);
    } else {
      assert.ok(existsSync(artifactPath), "the first matrix row should produce the shared artifact");
      args.push("--tarball", artifactPath);
    }
    if (row.installPreference === "online") {
      args.push("--prefer-online");
    }

    runNpm(args);
    assert.ok(existsSync(artifactPath), `matrix artifact should exist after ${row.id}`);
    const currentSha512 = hashFile(artifactPath, "sha512", "base64");
    if (artifactSha512 === null) {
      artifactSha512 = currentSha512;
    } else {
      assert.equal(currentSha512, artifactSha512, "all matrix rows should use one exact artifact");
    }
  }

  console.log(JSON.stringify({
    matrixSchemaVersion: matrix.schemaVersion,
    artifact: {
      filename: artifactFilename,
      size: statSync(artifactPath).size,
      integrity: `sha512-${artifactSha512}`,
    },
    rows: matrix.rows.map((row) => ({
      id: row.id,
      requestedVersions: row.versions,
      installPreference: row.installPreference,
    })),
  }, null, 2));
  console.log("Supported peer-version matrix passed against one packed monitor artifact.");
} finally {
  const resolvedWorkspace = realpathSync(workspace);
  assert.ok(
    isWithin(realpathSync(tmpdir()), resolvedWorkspace) &&
      basename(resolvedWorkspace).startsWith("causal-order-monitor-peer-matrix-"),
    "peer-matrix cleanup target should be scoped to the expected OS temp directory",
  );
  rmSync(resolvedWorkspace, { recursive: true, force: true });
}

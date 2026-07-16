import assert from "node:assert/strict";

import { projectFilesystemStorage } from "../.build/src/storage/storagePressure.js";

const totalBytes = 1_000_000n;
const cases = [
  ["zero available", 0n, "critical", 100],
  ["immediately below five percent", 49_999n, "critical", 95],
  ["exactly five percent", 50_000n, "critical", 95],
  ["immediately above five percent", 50_001n, "elevated", 94.99],
  ["immediately below fifteen percent", 149_999n, "elevated", 85],
  ["exactly fifteen percent", 150_000n, "elevated", 85],
  ["immediately above fifteen percent", 150_001n, "normal", 84.99],
  ["all available", totalBytes, "normal", 0],
];

for (const [name, availableBytes, pressure, usedPercent] of cases) {
  assert.deepEqual(
    projectFilesystemStorage(availableBytes, totalBytes),
    { pressure, usedPercent },
    name,
  );
}

for (const [name, availableBytes, invalidTotalBytes] of [
  ["zero total", 0n, 0n],
  ["negative total", 0n, -1n],
  ["negative available", -1n, totalBytes],
  ["available exceeds total", totalBytes + 1n, totalBytes],
]) {
  assert.deepEqual(
    projectFilesystemStorage(availableBytes, invalidTotalBytes),
    { pressure: "unknown", usedPercent: null },
    name,
  );
}

console.log(
  `storage pressure contract passed: ${cases.length + 4} exact threshold and invalid-metadata projections`,
);

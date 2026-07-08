import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { createDefaultMonitorNow } from "../.build/src/index.js";

const originalDateNow = Date.now;

try {
  Date.now = () => 1_700_000_000_000;
  const now = createDefaultMonitorNow();
  const first = now();

  Date.now = () => 1_600_000_000_000;
  await delay(10);
  const second = now();

  assert.ok(second >= first);
  assert.ok(second - first >= 0n);
  assert.ok(second - first < 1_000n);
} finally {
  Date.now = originalDateNow;
}

console.log(
  "monotonic now passed: default monitor clock is anchored to startup wall-clock and does not move backward during runtime",
);

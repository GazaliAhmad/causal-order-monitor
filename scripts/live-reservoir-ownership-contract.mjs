import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const readme = read("README.md");
const persistence = read("docs/persistence-operations.md");
const runbook = read("docs/operator-runbook.md");

assert.match(readme, /One live SQLite reservoir has one owning `MonitorRuntime`/);
assert.match(readme, /not a cross-process lock, leader-election mechanism/);
assert.match(persistence, /one owning monitor runtime for each SQLite reservoir/);
assert.match(persistence, /does not provide a cross-process lock, distributed lease, leader election/);
assert.match(persistence, /Backup, restore, relocation, and restart are stopped-database operations/);
assert.match(runbook, /Do not start a second runtime or adapter against the same reservoir/);
assert.match(runbook, /stop and close the existing owner first/);

console.log("Live reservoir ownership documentation contract passed.");

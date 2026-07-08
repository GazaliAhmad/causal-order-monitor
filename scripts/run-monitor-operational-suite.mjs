import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_NODE_IDS = [
  "edge-a",
  "edge-b",
  "edge-c",
  "edge-d",
  "edge-e",
  "edge-f",
  "edge-g",
  "edge-h",
];

const SUITE_SCENARIOS = {
  smoke: [
    "monitor-healthy-rolling-4h",
    "monitor-order-outage",
    "monitor-dual-outage",
  ],
  full: [
    "monitor-healthy-rolling-4h",
    "monitor-transport-outage-burst",
    "monitor-dedupe-outage",
    "monitor-order-outage",
    "monitor-dual-outage",
    "monitor-recovery-through-dedupe",
  ],
};

function findOptionValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === name) {
      return args[index + 1] ?? null;
    }
    if (token.startsWith(`${name}=`)) {
      return token.slice(name.length + 1);
    }
  }
  return null;
}

function readOptionList(args, name, fallback) {
  const value = findOptionValue(args, name);
  if (!value) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getSuiteDefaults(suiteName) {
  if (suiteName === "smoke") {
    return {
      duration: "8m",
      timeScale: "90",
      scenarioIds: SUITE_SCENARIOS.smoke,
    };
  }

  return {
    duration: "20m",
    timeScale: "60",
    scenarioIds: SUITE_SCENARIOS.full,
  };
}

function snapshotRunFolders() {
  const runsDir = resolve("artifacts", "runs");
  mkdirSync(runsDir, { recursive: true });
  return new Set(readdirSync(runsDir));
}

function diffRunFolders(before, after) {
  return [...after].filter((folder) => !before.has(folder));
}

const args = process.argv.slice(2);
const suiteName = findOptionValue(args, "--suite") ?? "full";
const suiteDefaults = getSuiteDefaults(suiteName);
const duration = findOptionValue(args, "--duration") ?? suiteDefaults.duration;
const timeScale = findOptionValue(args, "--time-scale") ?? suiteDefaults.timeScale;
const nodeIds = readOptionList(args, "--node-ids", DEFAULT_NODE_IDS);
const scenarioIds = readOptionList(args, "--scenarios", suiteDefaults.scenarioIds);
const outputDir = resolve("artifacts", "validation");
const suiteStem = `monitor-operational-suite-${suiteName}`;
const manifestPath = resolve(outputDir, `${suiteStem}.manifest.json`);
const summaryPath = resolve(outputDir, `${suiteStem}.json`);
const harnessScriptPath = resolve("scripts", "run-monitor-harness.mjs");
const summarizeScriptPath = resolve("scripts", "summarize-monitor-suite.mjs");

mkdirSync(outputDir, { recursive: true });

const runDirs = [];

for (const scenarioId of scenarioIds) {
  const beforeRuns = snapshotRunFolders();
  const runName = `${suiteStem}-${scenarioId}`;
  const harnessArgs = [
    harnessScriptPath,
    "--monitor-scenario",
    scenarioId,
    "--duration",
    duration,
    "--time-scale",
    timeScale,
    "--profile",
    scenarioId,
    "--node-ids",
    nodeIds.join(","),
    "--run-name",
    runName,
  ];

  const result = spawnSync(process.execPath, harnessArgs, {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const afterRuns = snapshotRunFolders();
  const newRunFolders = diffRunFolders(beforeRuns, afterRuns);
  const matchingRunFolder =
    newRunFolders.find((folder) => folder.includes(runName)) ??
    [...afterRuns]
      .filter((folder) => folder.includes(runName))
      .sort()
      .at(-1);

  if (!matchingRunFolder) {
    throw new Error(`Could not locate run directory for ${scenarioId}.`);
  }

  runDirs.push(resolve("artifacts", "runs", matchingRunFolder));
}

const manifest = {
  generatedAt: new Date().toISOString(),
  suiteName: suiteStem,
  scenarioIds,
  runDirs,
  defaults: {
    duration,
    timeScale,
    nodeIds,
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const summarizeResult = spawnSync(
  process.execPath,
  [
    summarizeScriptPath,
    "--manifest",
    manifestPath,
    "--output",
    summaryPath,
  ],
  {
    stdio: "inherit",
  },
);
if (summarizeResult.status !== 0) {
  process.exit(summarizeResult.status ?? 1);
}

console.log(`monitor operational suite completed: ${summaryPath}`);

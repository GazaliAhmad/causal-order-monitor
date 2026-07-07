import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function toNumber(value, fallback = 0) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return Number(value);
  }
  return fallback;
}

function summarizeRun(runDir) {
  const summaryPath = join(runDir, "summary.json");
  const monitorSummaryPath = join(runDir, "monitor-summary.json");
  const runConfigPath = join(runDir, "run-config.json");

  const summary = readJsonFile(summaryPath);
  const monitorSummary = existsSync(monitorSummaryPath)
    ? readJsonFile(monitorSummaryPath)
    : null;
  const runConfig = existsSync(runConfigPath)
    ? readJsonFile(runConfigPath)
    : null;

  return {
    runDir,
    runFolder: basename(runDir),
    scenarioId:
      monitorSummary?.scenarioId ??
      summary.monitor?.scenarioId ??
      runConfig?.monitorConfig?.scenarioId ??
      null,
    profileName: summary.config?.profileName ?? null,
    nodeCount: Array.isArray(summary.config?.nodeIds)
      ? summary.config.nodeIds.length
      : 0,
    nodeIds: Array.isArray(summary.config?.nodeIds) ? summary.config.nodeIds : [],
    durationMs: summary.config?.durationMs ?? null,
    timeScale: summary.config?.timeScale ?? null,
    wallElapsedMs: summary.timing?.wallElapsedMs ?? null,
    simulatedElapsedMs: summary.timing?.simulatedElapsedMs ?? null,
    receivedEvents: summary.transport?.receivedEvents ?? 0,
    orderedEvents: summary.stream?.orderedEvents ?? 0,
    anomalies: summary.stream?.anomalies ?? 0,
    dedupeDroppedDuplicates: summary.dedupe?.droppedDuplicates ?? 0,
    monitor: monitorSummary
      ? {
          bufferedEvents: monitorSummary.bufferedEvents ?? 0,
          replayState: monitorSummary.replayState ?? null,
          routingModes: monitorSummary.routingModes ?? {},
          deliveryModes: monitorSummary.deliveryModes ?? {},
          pendingRows: monitorSummary.pendingRows ?? 0,
          oldestPendingAgeMs: monitorSummary.oldestPendingAgeMs ?? "0",
          analysis: monitorSummary.analysis ?? {},
        }
      : null,
  };
}

const args = process.argv.slice(2);
const manifestPath = findOptionValue(args, "--manifest");
const outputPathArg = findOptionValue(args, "--output");

if (!manifestPath) {
  throw new Error("Missing required --manifest argument.");
}

const resolvedManifestPath = resolve(manifestPath);
const manifest = readJsonFile(resolvedManifestPath);
const runDirs = Array.isArray(manifest.runDirs) ? manifest.runDirs : [];
const scenarioSummaries = runDirs.map((runDir) => summarizeRun(runDir));

const report = {
  generatedAt: new Date().toISOString(),
  suiteName: manifest.suiteName ?? null,
  scenarioIds: manifest.scenarioIds ?? [],
  defaults: manifest.defaults ?? {},
  runDirs,
  scenarios: scenarioSummaries,
  aggregate: {
    scenarioCount: scenarioSummaries.length,
    totalReceivedEvents: scenarioSummaries.reduce(
      (sum, scenario) => sum + toNumber(scenario.receivedEvents),
      0,
    ),
    totalOrderedEvents: scenarioSummaries.reduce(
      (sum, scenario) => sum + toNumber(scenario.orderedEvents),
      0,
    ),
    totalBufferedEvents: scenarioSummaries.reduce(
      (sum, scenario) => sum + toNumber(scenario.monitor?.bufferedEvents),
      0,
    ),
    totalAnomalies: scenarioSummaries.reduce(
      (sum, scenario) => sum + toNumber(scenario.anomalies),
      0,
    ),
    drainedScenarios: scenarioSummaries.filter(
      (scenario) => scenario.monitor?.analysis?.endedDrained === true,
    ).length,
  },
};

const outputPath = outputPathArg
  ? resolve(outputPathArg)
  : resolve(
      "artifacts",
      "validation",
      `${manifest.suiteName ?? "monitor-operational-suite"}.json`,
    );
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  `monitor suite summary written: ${outputPath}`,
);

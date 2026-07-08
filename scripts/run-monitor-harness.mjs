import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const localMonitorModuleUrl = pathToFileURL(
  resolve(".build/src/index.js"),
).href;
const harnessScript = resolve(
  "node_modules/@causal-order/testing/bin/causal-order-testing-adapter-runtime.js",
);
const userArgs = process.argv.slice(2);

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

function hasOption(args, name) {
  return findOptionValue(args, name) !== null || args.includes(name);
}

function sanitizeFileStem(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

const runName = findOptionValue(userArgs, "--run-name");
const defaultMonitorDbPath = resolve(
  tmpdir(),
  `${sanitizeFileStem(runName ?? "monitor-harness")}.sqlite`,
);

const defaultArgs = [
  harnessScript,
  "--adapter",
  "@causal-order/transport/testing",
  "--monitor",
  "--monitor-module",
  localMonitorModuleUrl,
];

if (!hasOption(userArgs, "--monitor-db")) {
  defaultArgs.push("--monitor-db", defaultMonitorDbPath);
}

const result = spawnSync(process.execPath, [
  ...defaultArgs,
  ...userArgs,
], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);

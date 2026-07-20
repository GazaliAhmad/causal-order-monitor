import { readFile, writeFile } from "node:fs/promises";

const checkOnly = process.argv.includes("--check");

const packageJsonPath = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const { version } = packageJson;

const replacements = [
  {
    path: new URL("../src/index.ts", import.meta.url),
    description: "exported package version",
    update(source) {
      return source.replace(
        /export const monitorPackageVersion = "[^"]+";/,
        `export const monitorPackageVersion = "${version}";`,
      );
    },
  },
  {
    path: new URL("../README.md", import.meta.url),
    description: "README published package version",
    update(source) {
      if (!/Published package version: `v[^`]+`/.test(source)) {
        throw new Error(
          "README.md is missing the published package version marker.",
        );
      }
      return source.replace(
        /Published package version: `v[^`]+`/,
        `Published package version: \`v${version}\``,
      );
    },
  },
];

let hasMismatch = false;

for (const target of replacements) {
  const current = await readFile(target.path, "utf8");
  const updated = target.update(current);

  if (current === updated) {
    continue;
  }

  hasMismatch = true;

  if (checkOnly) {
    console.error(
      `Version mismatch detected in ${target.description}. Run npm run publish:prepare.`,
    );
    continue;
  }

  await writeFile(target.path, updated);
  console.log(`Synced ${target.description} to v${version}.`);
}

const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const changelog = await readFile(changelogPath, "utf8");
if (!changelog.includes(`## v${version}`)) {
  console.error(`CHANGELOG.md is missing an entry for v${version}.`);
  hasMismatch = true;
}

if (checkOnly && hasMismatch) {
  process.exitCode = 1;
} else if (!checkOnly) {
  console.log(`Publish metadata is ready for v${version}.`);
}

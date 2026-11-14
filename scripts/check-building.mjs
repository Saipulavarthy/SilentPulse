#!/usr/bin/env node
/**
 * Print buildingAt(lat, lng) for each coordinate pair.
 * Usage: node scripts/check-building.mjs <lat> <lng> [<lat> <lng> ...]
 *
 * Spawns Node with TypeScript strip-types so it can load lib/buildingLookup.ts
 * (which reads data/*.json from process.cwd()).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length < 2 || args.length % 2 !== 0) {
  console.error(
    "Usage: node scripts/check-building.mjs <lat> <lng> [<lat> <lng> ...]",
  );
  process.exit(1);
}

const pairs = [];
for (let i = 0; i < args.length; i += 2) {
  const lat = Number(args[i]);
  const lng = Number(args[i + 1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.error(
      `Invalid lat/lng at argv ${i + 2}/${i + 3}:`,
      args[i],
      args[i + 1],
    );
    process.exit(1);
  }
  pairs.push([lat, lng]);
}

const lookupUrl = pathToFileURL(path.join(root, "lib/buildingLookup.ts")).href;
const runner = `
import { buildingAt } from ${JSON.stringify(lookupUrl)};
const pairs = ${JSON.stringify(pairs)};
for (const [lat, lng] of pairs) {
  const building = buildingAt(lat, lng);
  console.log(JSON.stringify({ lat, lng, building }, null, 2));
}
`;

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", runner],
  {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);

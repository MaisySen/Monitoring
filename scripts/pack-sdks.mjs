#!/usr/bin/env node
// Packs the client SDKs into artifacts/api-server/downloads/ so the published onboarding
// snippets (npm install <server>/downloads/monitoring-trace-0.1.0.tgz and the Python wheel)
// resolve against a self-hosted server. The Node tgz is required; the Python wheel needs
// `pip install build` and is SKIPPED WITH A LOUD WARNING when unavailable - never silently.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dest = path.join(root, "artifacts/api-server/downloads");
fs.mkdirSync(dest, { recursive: true });

const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", dest, path.join(root, "sdks/node")], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();
console.log(`packed ${tgz}`);

try {
  execFileSync("python3", ["-m", "build", "--wheel", "--outdir", dest, path.join(root, "sdks/python")], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  console.log("packed monitoring_trace wheel");
} catch {
  console.warn("WARNING: Python SDK wheel NOT packed (python3 -m build unavailable; pip install build).");
  console.warn("WARNING: the /downloads/monitoring_trace-0.1.0-py3-none-any.whl onboarding snippet will 404 until this is fixed.");
}

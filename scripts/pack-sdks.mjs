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

// Agent binaries: copied from agent/dist (populated by agent/build.sh or by downloading a CI release
// artifact), each file verified against agent/dist/SHA256SUMS before copying. FAIL CLOSED when absent
// or mismatched: the published install.sh path depends on these files, and a placeholder or unverified
// binary must never reach downloads. The verified SHA256SUMS is copied alongside so the installer's
// cross-host checksum fallback resolves to the same provenance.
const agentDist = path.join(root, "agent/dist");
const sumsPath = path.join(agentDist, "SHA256SUMS");
if (!fs.existsSync(sumsPath)) {
  console.error("ERROR: agent/dist/SHA256SUMS missing. Build the agent (agent/build.sh) or download the CI release artifact into agent/dist/.");
  console.error("ERROR: refusing to pack without verified agent binaries (no placeholders, no unverified binaries).");
  process.exit(1);
}
const sums = fs.readFileSync(sumsPath, "utf8").split("\n").filter(Boolean).map(line => {
  const [hash, name] = line.trim().split(/\s+/);
  return { hash, name };
});
if (sums.length === 0) {
  console.error("ERROR: agent/dist/SHA256SUMS is empty.");
  process.exit(1);
}
const { createHash } = await import("node:crypto");
for (const { hash, name } of sums) {
  const file = path.join(agentDist, name);
  if (!fs.existsSync(file)) {
    console.error(`ERROR: ${name} listed in SHA256SUMS but missing from agent/dist/.`);
    process.exit(1);
  }
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== hash) {
    console.error(`ERROR: checksum mismatch for ${name}: expected ${hash}, got ${actual}. Refusing to pack.`);
    process.exit(1);
  }
  fs.copyFileSync(file, path.join(dest, name));
  console.log(`packed ${name} (sha256 verified)`);
}
fs.copyFileSync(sumsPath, path.join(dest, "SHA256SUMS"));
console.log("packed SHA256SUMS");

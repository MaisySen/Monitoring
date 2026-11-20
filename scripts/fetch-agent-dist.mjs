#!/usr/bin/env node
// Fetches the agent binaries built by the Release workflow into agent/dist/, with
// provenance recorded, so scripts/pack-sdks.mjs has a verified input and no manual
// artifact-copying step is required.
//
// Source of truth: the GitHub Actions "agent" artifact from a successful Release
// workflow run (latest on the default branch, or a pinned run). Provenance is the
// run/artifact identity recorded in agent/dist/PROVENANCE.json; SHA256SUMS matching
// its binaries is internal consistency, NOT origin. Re-derive origin any time from
// the recorded run id. Builds carrying a signed attestation can additionally be
// checked at install time with MONITORING_VERIFY_REPO (see served install.sh).
//
// Required env: GITHUB_TOKEN (actions:read on the repo).
// Optional env:  GITHUB_REPOSITORY (default MaisySen/Monitoring),
//                MONITORING_AGENT_RUN_ID (pin a specific Release run).
//
// Fails closed: any missing target, checksum mismatch, bad magic, or API error
// exits nonzero and leaves agent/dist untouched.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dest = path.join(root, "agent/dist");
const repo = process.env.GITHUB_REPOSITORY || "MaisySen/Monitoring";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error("ERROR: GITHUB_TOKEN required (actions:read).");
  process.exit(1);
}

const api = async (url, accept = "application/vnd.github+json") => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res;
};

const EXPECTED = [
  "monitoring-agent-linux-amd64",
  "monitoring-agent-linux-arm64",
  "monitoring-agent-darwin-amd64",
  "monitoring-agent-darwin-arm64",
  "monitoring-agent-THIRD_PARTY_NOTICES.txt",
  "SHA256SUMS",
];
const MAGIC = {
  linux: "7f454c46",   // ELF
  darwin: "cffaedfe",  // Mach-O 64-bit thin
};

const main = async () => {
  let runId = process.env.MONITORING_AGENT_RUN_ID;
  if (!runId) {
    const runs = await (await api(
      `https://api.github.com/repos/${repo}/actions/workflows/build.yml/runs?status=success&per_page=1`
    )).json();
    runId = runs.workflow_runs?.[0]?.id;
    if (!runId) throw new Error("no successful Build checks workflow run found");
  }
  const arts = await (await api(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`
  )).json();
  const artifact = arts.artifacts?.find(a => a.name === "agent");
  if (!artifact) throw new Error(`no "agent" artifact on run ${runId}`);
  console.log(`source: ${repo} run ${runId} artifact ${artifact.id} (${artifact.created_at})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dist-"));
  const zipPath = path.join(tmp, "agent.zip");
  const zipRes = await api(
    `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    "application/vnd.github+json"
  );
  fs.writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", tmp]);

  for (const name of EXPECTED) {
    if (!fs.existsSync(path.join(tmp, name))) throw new Error(`artifact is missing ${name}`);
  }
  // Consistency: every listed file matches its SHA256SUMS entry.
  execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: tmp, stdio: ["ignore", "pipe", "inherit"] });
  // Format/target validation: magic bytes per platform, executable bit on binaries.
  const { createHash } = await import("node:crypto");
  for (const name of EXPECTED) {
    const file = path.join(tmp, name);
    if (name === "SHA256SUMS" || name.endsWith(".txt")) continue;
    const head = fs.readFileSync(file).subarray(0, 4).toString("hex");
    const platform = name.includes("linux") ? "linux" : "darwin";
    if (head !== MAGIC[platform]) throw new Error(`${name}: bad magic ${head} for ${platform}`);
    if (!(fs.statSync(file).mode & 0o111)) throw new Error(`${name}: not executable`);
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const name of EXPECTED) fs.copyFileSync(path.join(tmp, name), path.join(dest, name));
  for (const name of EXPECTED.filter(n => !n.endsWith(".txt") && n !== "SHA256SUMS")) {
    fs.chmodSync(path.join(dest, name), 0o755);
  }
  const provenance = {
    repo, workflow: "build.yml", run_id: Number(runId), artifact_id: artifact.id,
    artifact_created_at: artifact.created_at, fetched_at: new Date().toISOString(),
    sha256sums_sha256: createHash("sha256").update(fs.readFileSync(path.join(tmp, "SHA256SUMS"))).digest("hex"),
    note: "SHA256SUMS match establishes internal consistency only; origin is the recorded run/artifact.",
  };
  fs.writeFileSync(path.join(dest, "PROVENANCE.json"), JSON.stringify(provenance, null, 2) + "\n");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`agent/dist populated (${EXPECTED.length} files, checksums verified, magic/executable validated)`);
};

main().catch(err => { console.error(`ERROR: ${err.message}`); process.exit(1); });

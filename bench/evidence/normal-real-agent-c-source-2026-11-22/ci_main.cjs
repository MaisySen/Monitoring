"use strict";
// CI entry for the Monitoring agent acceptance run. Replaces the local-cluster owner
// and the cross-run attestation with same-job custody:
//   verified source tree + verified dependency closure + binary hash recorded at build
//   and re-hashed immediately before launch. It is not cross-run reproducibility.
// Invoked as (cwd ROOT/artifacts/api-server, tsx loader):
//   node --import tsx ci_main.cjs ROOT MODE BINARY EXPECTED_BINARY_SHA256 CLOSURE_MANIFEST RESULT CUSTODY
// The admin DSN arrives only through DATABASE_URL and must be a loopback host.
const path = require("node:path"), fs = require("node:fs/promises"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
async function main(argv, env) {
  const [root, mode, binary, expectedSha, manifestPath, resultPath, custodyPath] = argv;
  if (argv.length !== 7 || ![root, binary, manifestPath, resultPath, custodyPath].every(p => path.isAbsolute(p))) return 2;
  if (mode !== "happy" || !/^[a-f0-9]{64}$/.test(expectedSha)) return 2;
  if (env.NORMAL_REAL_C_SOURCE_EXECUTE !== "reviewed-real-agent-c-v1" || env.NORMAL_REAL_C_PG_AUTHORITY !== "owned-local-create-drop-reviewed") return 2;
  if (env.GITHUB_ACTIONS !== "true" || typeof env.DATABASE_URL !== "string") return 2;
  const { createCoordinator, verifyNodeClosure, relativePath } = require("./coordinator.cjs");
  const files = { read: p => fs.readFile(path.resolve(root, relativePath(p))) };
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const checks = [];
  const recover = async () => {
    // Called by the coordinator before any DB or child, and again right before launch.
    await verifyNodeClosure(files, manifest, manifest.commit, hash);
    const bytes = await fs.readFile(binary);
    assert.equal(hash(bytes), expectedSha, "binary hash changed since build");
    checks.push({ closureFiles: manifest.files.length, binarySHA256: expectedSha });
    return { binary, closureBinding: manifest.commit };
  };
  const run = createCoordinator({ recoverAttestation: recover });
  let out;
  try { out = await run({ root, mode, adminURL: env.DATABASE_URL, attestationPath: custodyPath, resultPath }); }
  catch { return 1; }
  const ok = out && out.resultWritten === true && out.result && out.result.status === "pass";
  const { execFileSync } = require("node:child_process");
  const git = a => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const checkedTree = git(["rev-parse", "HEAD^{tree}"]);
  const record = {
    schema: "same-job-custody-v1", status: ok ? "pass" : "failed", mode,
    closureBinding: manifest.commit, checkedTree, checkedCommit: git(["rev-parse", "HEAD"]),
    manifestSHA256: hash(manifestBytes), manifestClosureFiles: manifest.files.length,
    binarySHA256: expectedSha, verificationsBeforeLaunch: checks.length,
    nodeVersion: process.version, note: "same-job source-to-executed-bytes custody; not an independent prior pin and not cross-run reproducibility"
  };
  await fs.writeFile(custodyPath, JSON.stringify(record, null, 1) + "\n", { flag: "wx", mode: 0o600 });
  return ok ? 0 : 1;
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2), process.env).then(c => { process.exitCode = c; });

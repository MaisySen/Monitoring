"use strict";
// PREPARED ONLY. Entry for the fresh-PG outer owner (pg_owner.py). No top-level
// effect unless run as the main module with every gate present. Invoked as:
//   /usr/bin/node --import tsx coordinator_main.cjs ROOT MODE ATTESTATION RESULT
// from cwd ROOT/artifacts/api-server. Admin DSN arrives only via DATABASE_URL
// (never argv). The coordinator itself enforces its own gates again.
const path = require("node:path");
async function main(argv, env, run) {
  const [root, mode, attestationPath, resultPath] = argv;
  if (argv.length !== 4 || !path.isAbsolute(root) || !path.isAbsolute(attestationPath) || !path.isAbsolute(resultPath)) return 2;
  if (env.NORMAL_REAL_C_SOURCE_EXECUTE !== "reviewed-real-agent-c-v1") return 2;
  if (env.NORMAL_REAL_C_PG_AUTHORITY !== "owned-local-create-drop-reviewed") return 2;
  const adminURL = env.DATABASE_URL;
  if (typeof adminURL !== "string" || adminURL.length === 0) return 2;
  let out;
  try { out = await run({ root, mode, adminURL, attestationPath, resultPath }); }
  catch { return 1; }               // no exception text: it may carry a DSN
  const ok = out && out.resultWritten === true && out.result &&
    (out.result.status === "pass" || (mode === "withheld-final-evidence" && out.result.status === "incomplete"));
  return ok ? 0 : 1;
}
module.exports = { main };
if (require.main === module) {
  const { runOwnedScenario } = require("./coordinator.cjs");
  main(process.argv.slice(2), process.env, runOwnedScenario).then(c => { process.exitCode = c; });
}

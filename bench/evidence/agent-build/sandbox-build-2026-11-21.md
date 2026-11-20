# Agent build provenance and sandbox rebuild attempt, 2026-11-21

## Provenance: the exercised agent binary is the CI build of current source
- "Build checks" CI run 44710994706 on commit 3a69d15: agent job SUCCESS (full from-scratch
  agent/build.sh, 20 min on a GitHub-hosted runner), artifact "agent" retrieved and hash-verified
  against its own SHA256SUMS: monitoring-agent-linux-amd64 = b98267a7c73226baeae1bfd54752773eb75854a231aa0fd75f4b949beb34714a.
- The binary the recovery benches and onboarding verification used (wo501 agent-topology 6/6
  zero-loss, okoz5 SDK-fix validation, cbazi shipped-config acceptance 6/6, and the 65f27d7
  onboarding verify) is byte-identical to that CI artifact (md5 3290c7da514a7edf3874140341276390).
  So the Go runtime WAS exercised end-to-end through those benches, via the CI artifact.
- Go source reconciliation: agent Go code at 3a69d15 is identical to current HEAD (the only agent
  changes since are an example-config rename and verify.sh +15 lines, neither compiled). No agent
  rebuild is outstanding: current source is exactly what the exercised binary was built from.
- The separate shipped downloads binary (artifacts/api-server/downloads/, sha256 f52cc944...) is an
  earlier build of the same Go source (built from the 4de9454 rebrand tree before the CI run). Same
  code, different build instance; Go build hashes are environment-sensitive.

## Sandbox rebuild attempt: blocked by RAM, not a product defect
- Rebuilding in THIS sandbox fails only on one dependency,
  github.com/DataDog/datadog-api-client-go/v2/api/datadogV2: kernel OOM killer terminates the
  compiler (dmesg: "Out of memory: Killed process 1518 (compile) total-vm:2557008kB,
  anon-rss:1304568kB"). Reproduced with -p 1, all other services stopped (1.6 GB available), and
  -gcflags='all=-l'. aws-sdk-go-v2/service/ec2 OOM'd only while other services ran; it compiles
  once memory is freed. Everything else in the module graph compiles and go mod tidy passes.
- Conclusion: the 2 GB sandbox cannot compile that one package; CI (which succeeds) is the
  authoritative agent build. No "4 GB minimum" is claimed or verified — only failure HERE is proven.

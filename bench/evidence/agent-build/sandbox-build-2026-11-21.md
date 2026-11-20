# Agent from-scratch build in this sandbox, 2026-11-21

agent/build.sh progress: the OTel collector builder runs, module graph resolves (go mod tidy
passes), and all packages compile except one dependency:
github.com/DataDog/datadog-api-client-go/v2/api/datadogV2 (a generated API client, one of the
largest Go packages in the module graph).

Failure evidence: kernel OOM killer terminates the compiler, captured in dmesg:
"Out of memory: Killed process 1518 (compile) total-vm:2557008kB, anon-rss:1304568kB".
Reproduced with -p 1 (no parallel compiles), with every other sandbox service stopped
(1.6 GB available), and with -gcflags='all=-l' (reduced inlining): the datadogV2 compile alone
exceeds this sandbox's 2 GB RAM. aws-sdk-go-v2/service/ec2 also OOM'd when other services were
running, then compiled once memory was freed.

Conclusion: environment limit, not a product defect. build.sh is unchanged and expects a normal
build machine (4 GB+). The sandbox agent binary used by the recovery benches was built elsewhere.
Next step if a local build is required: build on a larger host or in CI and record the artifact hash.

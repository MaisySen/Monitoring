# Three-hour acceptance evidence

## Current acceptance boundary, 2026-11-21 22:00 Sydney

This section supersedes historical unverified install/soak notes below. Tested product source is
`0c558e370abb9a883e8243e4df5f2255ca618450`, not every later documentation/harness commit.
Exact-source build44878114550 was green. Its agent artifact14696432658 was downloaded and verified
against all five SHA256SUMS entries before the new local nine-check suite passed, exit0.
Evidence: `bench/evidence/acceptance-0c558e3/`.

Independent focused review accepted F1-F4 at that source: metadata/query/discovery/host parity,
encoding-matched duplicate ACK, claim-before-point-quota accounting and explicit strict raw-body
identity. API-server113 and SDK28 passed. Extra metric retries remain defaultOFF and opt-in
TEST-ONLY, not approved for production. Postcommit host/app metadata can remain incomplete after
points commit and503, then duplicate200 without repair until a later fresh batch; per-org quota
row serialization is a throughput consideration. All previous retention/config, in-flight-send,
older-server and ClickHouse limits remain.

A separate free standard-runner acceptance job completed three continuous hours at that exact
product source, harness `c59ff63f41aebd51eaf38a00233946918527ed86`, actual exact-source CI artifact.
Run: https://github.com/MaisySen/Monitoring/actions/runs/44881122584 .

- Requested180min; elapsed10831s. Spans1294576 sent/stored, logs220029 sent/stored,0 request errors.
-181 periodic functional query/discovery/host/monitor samples; worst monitor evaluation staleness
 19.10s. Server RSS132-199MB, first132/last199. This does not establish flat memory or leak absence.
-20traces/s,10 synthetic hosts,8 services,200 custom cardinality; not throughput/capacity proof.
 Metric points273320 emitted, not reconciled to storage; no query-latency SLO assertion.
- Default-path systemd enable/start/stop/start/restart passed on the disposable VM. Installed
 binary matched artifact SHA;1286 metric points/257 series stored. Cleanup passed. No VM reboot
 was performed, so persistence through a real reboot remains unverified.
- No paid runner, new artifact/cache upload, live deployment, release, or account change. Only
 synthetic local credentials and data; sanitized evidence retained, not credential-bearing logs.

Evidence: `bench/evidence/acceptance-3h-44881122584/summary.json` and `safe-evidence.jsonl`.
A preceding5min smoke passed after a failed smoke exposed an overly strict discovery freshness
assertion; the long run has its own result, not an extrapolation from that smoke.

Remaining gates are not erased by this result: Multies bridge changes remain HELD pending owner
authority; live deployment/release/spend/default-on remain unapproved; real reboot behavior,
metrics sent/stored reconciliation, capacity and latency bounds need their own scoped checks.


The JSONL contains only parsed result/sample/systemd records from job136776415192. Full public run logs remain at the run URL; setup/server response bodies and credentials are excluded. The summary was recomputed from181 sample records, and required elapsed>=10800, pass=true, zero request errors and span/log equality.

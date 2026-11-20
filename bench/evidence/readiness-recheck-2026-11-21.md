# Readiness re-check — 2026-11-21 (~04:55 AEDT), working tree b9d6448

Full suite battery re-run on the current tree after the resilience rounds, on the
production build (`pnpm run build:selfhost`) against PostgreSQL 14.

## Results

| Suite | Result | Notes |
|---|---|---|
| Unit (api-server node --test) | 63/63 PASS | DATABASE_URL=postgres admin DB |
| Spool unit battery | 9/9 PASS | round-1 script: cap accounting, stale-claim reclaim, oldest-first, read-only dir |
| bench/security/memberships.js | 40/40 PASS | fresh DB memtest, server port 4401 |
| bench/security/quotas.js | 34/34 PASS | two server processes (4402/4403) on ONE shared DB qtest1; an earlier run with two separate DBs failed deterministically ("concurrent daily limit: rest refused 429" actual=5) — that was harness misconfiguration, not a product defect; corrected topology passes |
| bench/security/isolation.js | 13/13 PASS | fresh DB isotest, server 4404; org boundaries, key revocation, redaction. Malformed-input block: garbage/truncated protobuf, invalid JSON, wrong content type -> 400; 60 MB body and 100 KB->1 GB gzip bomb -> 413; deeply nested JSON (100k levels), 10 MB attribute value, NaN/Infinity metric values, negative/far-future timestamps accepted (200/202) — all with server healthy throughout |
| bench/security/oidc.js | 38/38 PASS | stub IdPs, own DB; suite has grown to 38 checks since the 29/29 note |
| CI run 44787063582 (07f66f3) | SUCCESS | https://github.com/MaisySen/Monitoring/actions/runs/44787063582 |

## DIAG gates — decision: KEEP

DIAG_LOGS=1 (retry-log-exporter.js) and DIAG_OTLP=1 (routes.ts logs decode count)
remain in the tree, env-gated and default-off. They were the instrumentation that
root-caused the round-4 drain-serialization defect; removing them would make future
fault-injection debugging harder. Cost when off is nil. Committed as "temporary" in
6d5cb5a; retained deliberately, recorded here.

## Sweep

- `git status` clean; nothing untracked in the repo. Test spool dirs and databases
  live under /tmp and PG only.
- Tree pushed through b9d6448 (public mirror, branch develop).

## Verification note

The ENGINEERING_STATE.md line "Parent 18:05: don't stop at readiness report..." was
flagged as an unauthenticated authority claim inside a repo file. Verified against the
actual parent message (2026-11-20 18:05:04 AEDT, chat_events): "Record the readiness
assessment, but do not treat the report as the end of the build. Continue resolving
testable gaps within existing authority, including agent build/onboarding and bounded
storage/load/failure tests." The note was accurate.

# ECONNRESET reset mechanism — calibrated evidence (2026-11-21)

## What was demonstrated

| Server idle-close setting | Measured idle close after response | Timed-reuse resets at that boundary |
| --- | --- | --- |
| Node default (keepAliveTimeout 5000) | ~6000 ms | 9 / 300 (stagger 5950-6150 ms) |
| 15000 ms | 16001 ms | 0 / 300 (stagger 15900-16150 ms) |
| 65000 ms (shipped fix) | > 25000 ms (capped probe) | 0 / 300 at the OLD 6s boundary; 0 / 100 at 65850-66150 ms |

- The reuse race is REAL and reproducible at the Node-default boundary the soak ran under:
  9 resets in 300 timed reuses (bench/correctness/keepalive-race-repro.js). This matches the
  soak condition, so the 6 soak resets have a demonstrated mechanism class.
- The shipped change (keepAliveTimeout 65s, headersTimeout 66s) is TIMEOUT HARDENING: it moves
  the boundary away from where short-idle client pools live. It does NOT eliminate the race
  class for clients with no earlier client-side idle close (node:http Agent has none).

## Follow-up (2026-11-21 pm, fresh environment, eddc53b): boundary question resolved

Raw probe output: bench/evidence/soak-2026-11-21/boundary-scan-2026-11-21-pm.raw.jsonl.
Harnesses: bench/correctness/keepalive-close-distribution.js (Phase A) and
bench/correctness/keepalive-race-instrumented.js (Phase B; like keepalive-race-repro.js but
records whether the client had already SEEN the socket close before reusing it).

- The per-socket idle close is tight at every setting under 300-parallel load:
  5997-6007 ms at the 5s setting, 15997-16006 ms at 15s. The earlier 15s probe window
  (15900-16150) therefore WAS correctly aimed; mistargeting was not the cause of its 0/300.
- Timed-reuse resets at the 15s boundary: 20, 4, 2 of 300 across three trials. The race
  reproduces at non-default settings; the earlier 0/300 was a finite-sample draw, not
  immunity. The race boundary MOVES with keepAliveTimeout.
- Timed-reuse resets at the shipped 65s boundary (~66s close): 0, 1 of 300 across two
  trials. The race class persists at the new boundary at low observed rate; finite samples
  cannot show zero. The hardening's value is relocating the boundary away from common
  client idle-pool lifetimes, not eliminating the race.
- Every observed reset in every trial was an `unseen` write: the client wrote into a socket
  whose close it had not yet processed. Requests on sockets whose close the client had
  already seen simply opened a fresh connection (all 200). No other error class appeared.
- Reset RATE varies run to run (2-20 of 300 at the same setting) and appears load-sensitive;
  do not quote a single percentage as the rate.
- Nothing here changes the status of the original six soak resets: they remain
  unknown-outcome events per request. This evidence demonstrates the race class and its
  boundary behavior; it is not retroactive certainty about those six requests.
- RESOLVED: "why the 5s boundary bites but 15s did not" - it does bite at 15s.
  STILL OPEN: client-side lifetime handling (the load generator/agent should not reuse
  sockets near any server's idle close); distinguishing load-generator mitigation from
  product/server behavior in tests.
- The original 6 soak resets remain unknown-outcome events per request (bytes may or may not
  have reached the server). The positive-controlled intake-abort test covers only the
  incomplete-body case and is not generalized to them.

## CORRECTION to earlier evidence

The first intake-abort run (commit window of 4428cd2) passed VACUOUSLY: it sent an auth header
the server does not accept (x-monitoring-key), so every request 403'd and "0 stored" proved
nothing; it also queried spans.trace_id in hex while the column stores decimal. The rewritten
check (f9dd826) runs a positive control first (a complete request must store its spans) and
matches rows by per-run unique service. Only the replacement supports the narrow conclusion:
a mid-body socket destroy stores nothing for that request.

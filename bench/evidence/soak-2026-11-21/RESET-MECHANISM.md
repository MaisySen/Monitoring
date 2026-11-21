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
- Boundary behavior at non-default settings was not reproduced within budget (0/300 at 15s,
  0/100 at ~66s). Why the 5s boundary bites and the 15s one did not is UNRESOLVED — do not
  claim the window simply moves with the setting.
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

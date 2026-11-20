# Direct-path disk spool: acceptance run, 2026-11-21

Feature: MONITORING_EXPORT_SPOOL_DIR (opt-in; unset keeps previous behavior) +
MONITORING_EXPORT_SPOOL_MAX_MB (default 50) in sdks/node (span and log exporters).
Batches whose retry window (default 30 s) expires, or that are flushed after shutdown begins,
are written to disk and re-sent oldest-first by a background drain; spool files survive process
restarts and are claimed by atomic rename before sending (two processes sharing a directory
cannot double-send; a crashed claimant's file is reclaimable after 60 s).

Bench: bench/resilience/server-only.js, scenario server_outage_long (real 45 s server kill at
t=20 s; the watchdog loop is killed too — an earlier run that killed only the node process was
vacuous because the loop restarted the server inside 2 s; that run was discarded).
RATE=100, SECONDS=100 so the generator outlives the outage and drain can complete.

Results (DB counts of stored unique seq vs generator-sent):
- Spool ON: 10,000/10,000 spans, 5,000/5,000 logs, 0 missing, 0 duplicates. The generator was
  SIGKILLed with one log batch still spooled; the next process with the same directory delivered
  it exactly once (restart durability).
- Spool OFF (negative control, same timeline): 4,109/6,000 spans lost, 2,031/3,000 logs lost.
  Proves the bench detects loss and the spool (not the retry window) closed it.
- Unit checks: 100-byte cap drops the oldest file and counts it; two concurrent drainers over 5
  files deliver 5 total, 0 duplicated, 0 left.

Fixed along the way (found by these tests, not by review):
- LogRecord JSON round-trip breaks the OTLP serializer (underscore-prefixed internal fields);
  spooled log records are rebuilt as plain objects at drain time.
- Spool claim is now an atomic rename; an overlapping drainer pair previously double-sent
  (measured 12,782 rows / 5,000 unique in the bench DB before the fix).

Acceptance scope: single-host spool directory (one writer at a time is now safe even with
overlap); drain delivers after recovery with no ordering guarantee across the spool boundary
(telemetry is timestamped; only live-tail interleaves). Crash reclaim of a stale claim file
(60 s) is code-reviewed but not fault-injected. Metrics exporter is not spooled (gap, documented
in sdks/node/README if kept; metric points are periodic gauges that re-report).

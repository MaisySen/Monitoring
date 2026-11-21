# Metrics intake batch idempotency - live verification (2026-11-21 pm, valrun instance, migration 20)

Server built from the working tree (writeMetrics batch claim + /otlp/v1/metrics x-monitoring-batch-id).
Payloads: OTLP/JSON, gauge idem.gauge, fixed timestamp. Assertions are positive stored-value counts
(metric_points joined to metric_series), not response-only.

| Case | Result |
| --- | --- |
| First delivery (batch-aaaa1111) | 200, points 0 -> 1 (stored) |
| Retry, same batch id + same body | 200 "duplicate batch ignored", count stays 1 (no double-count) |
| Same batch id + different body | 409 "batch id reused with different content", count stays 1 |
| Distinct batch id + identical points | 200, count 1 -> 2 (legitimate same-timestamp samples preserved) |
| No batch id header | 200, count 2 -> 3 (back-compat: no dedup without the header) |
| 5 concurrent identical deliveries (batch-conc4444) | all 200, count 3 -> 4 exactly once; 1 claim row |

Also observed (edge): an empty metrics body still claims its batch id (200, nothing stored); a later
real payload under the same id gets 409. Acceptable: reuse with changed content is a client bug.

Not covered live here (server unit tests own them): mid-ingest rollback (claim must roll back with
the points so a retry re-ingests) and cross-org isolation of the same batch id.

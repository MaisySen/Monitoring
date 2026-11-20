# Difficult queries under load

Times the API calls Monitoring's UI makes for its hardest screens: high-cardinality metrics, 7-day ranges, and large log and span searches. Each runs **while ingestion is running**: `bench/scale/loadgen.js` at 400 traces/s, which is about 2,400 spans/s, 400 logs/s and 20,000-series custom metrics, sent straight to intake.

| Script | What it does |
|---|---|
| `hard-queries.sh <label>` | 15 queries, 3 runs each, median reported (one JSON line per query) |
| `ab-metrics.js` | Same-data A/B for the metric engine: two API builds on one database, interleaved, checks the answers are identical |

Both scripts log in with `MONITORING_URL`, `MONITORING_EMAIL` and `MONITORING_PASSWORD`.

## What changed

1. **Span and log search on `service:` / `env:`** compared lowercased columns per row (`lower(service) = …`), so no index could be used. Values are now lowercased once at intake and matched exactly, using the existing `(org_id, service, ts)` indexes.
2. **Span facets** read whole span rows, including attributes and metrics JSON, to count a handful of columns. They now read only the faceted columns, from a recent sample.
3. **`@attribute:value` log search** scanned JSON per row. It now uses JSONB containment (`attributes @> {…}`) backed by a GIN index on `logs.attributes`. The index is built in the background (`CREATE INDEX CONCURRENTLY`) on first start, so intake is never blocked. On a 3.4M-row log table it took 15 s.
4. **Metric queries** loaded every series of a metric ever seen, then pulled every series' points into Node to group them. Now:
   - only series that reported in the window are loaded (`last_seen ≥ from − 15 min`; `last_seen` is refreshed at most every 5 minutes at intake);
   - the per-group time and space aggregation runs in Postgres, so one row per group per bucket comes back, not one per series per bucket.

   (An earlier push-down that parsed tags per row in SQL was slower and was dropped. Here group membership is still decided in Node, and only an `(series id, group id)` array goes to Postgres.)

## Before vs after (full suite, under load)

Median of 3 runs, in ms. **The database grew between the two runs**: the "after" run had a 19 GB database with 18.4M spans, 3.4M logs, 19.4M metric points and 302k metric series, about 3× the high-cardinality series of the "before" run. Slower rows below mostly reflect the larger data, not the code; see the same-data A/B further down.

| Query | Before | After | Change |
|---|---:|---:|---|
| Span facets, 24 h | 66,205 | 133 | **498× faster** |
| Span search `service:… status:error`, 24 h | 4,034 (80 s cold) | 5 (96 ms cold) | **800× faster** |
| Log search `@customer.id:…`, 24 h | 3,416 | 11 | **310× faster** |
| Log facets, 24 h | 104 | 34 | 3× faster |
| Log search `service:… status:error`, 24 h | 838 | 346 | 2.4× faster |
| Log full-text search, 24 h | 254 | 99 | 2.6× faster |
| Log toplist by service, 24 h | 513 | 362 | 1.4× faster |
| Log histogram, 7 d | 351 | 325 | same |
| High-cardinality sum by plan, 1 h | 1,384 | 1,297 | same, on 3× the series |
| High-cardinality total, 1 h | 1,262 | 1,109 | 1.1× faster, on 3× the series |
| High-cardinality top 10 customers, 1 h | 1,182 | 2,191 | slower: more series (A/B: 5.5× faster than old code) |
| Host CPU by host, 7 d | 144 | 172 | same |
| Trace metric by service, 7 d | 715 | 1,460 | slower: more data (A/B: same as old code) |
| APM services list, 7 d | 617 | 780 | slower: more spans (not changed) |
| APM service page, 7 d | 71 | 152 | slower: more spans (not changed) |

## Same-data A/B for the metric engine

The previous build (A) and the new build (B) run side by side on one database, under the same load. Each query runs 3 rounds, alternating which build goes first. Answers are compared bucket by bucket (relative difference < 1e-6, ignoring the last 2 minutes, which are still filling). Raw data: `ab-metrics.json`.

| Query | A (ms) | B (ms) | Speedup | Same answer |
|---|---:|---:|---:|---|
| High-cardinality sum by plan, 1 h | 2,582 | 1,146 | 2.3× | yes |
| High-cardinality total, 1 h | 2,536 | 1,008 | 2.5× | yes |
| High-cardinality top 10 customers, 1 h | 20,529 | 3,707 | 5.5× | yes |
| High-cardinality sum by plan, 4 h | 2,790 | 1,695 | 1.6× | yes |
| High-cardinality avg by plan, 24 h | 2,447 | 2,620 | 0.9× (no gain) | yes |
| Host CPU by host, 7 d | 151 | 205 | ~same | yes |
| Host CPU max, 1 h | 134 | 127 | ~same | yes |
| Trace metric by service, 7 d | 1,362 | 1,444 | ~same | yes |
| Trace rate, 1 h | 1,306 | 1,288 | same | yes |

## Remaining limit

Over 24 hours, the high-cardinality metric touches every one of its ~267k series, and Postgres reads about 1.2M points across them. `EXPLAIN ANALYZE` shows about 1 s of that is disk reads. The data has only 4–5 points per series, so per-series time rollups would not shrink it. Doing better needs columnar storage, or pre-aggregation by commonly grouped tags. Both are documented as future work, not built.

## Reproduce

```bash
# load (20 min)
MONITORING_API_KEY=… RUN=q TRACES_PER_S=400 SECONDS=1200 node bench/scale/loadgen.js &
sleep 60
bash bench/queries/hard-queries.sh after-under-load > after.jsonl
# same-data A/B: run the old build on :8081 and the new build on :8082 (MONITORING_BACKGROUND_JOBS=false), then
A=http://localhost:8081 B=http://localhost:8082 ROUNDS=3 node bench/queries/ab-metrics.js > ab-metrics.json
```

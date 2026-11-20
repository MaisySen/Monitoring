# Data isolation and protection tests

`MONITORING_URL=http://127.0.0.1:3000 DATABASE_URL=postgresql://... node bench/security/isolation.js > results.json` runs against any Monitoring server. It needs psql access to create a second organization with a user and an API key.

## Latest run (`isolation-2.json`): 13/13 checks pass

| Area | Check | Result |
| --- | --- | --- |
| Org boundaries | both orgs ingest traces, logs and metrics with their own key | 200 ×6 |
| Org boundaries | org B sees none of org A's data | no leaks |
| Org boundaries | org A sees none of org B's data | no leaks |
| Org boundaries | an org sees its own data (sanity) | yes |
| Org boundaries | cross-org access by id: monitor GET/PUT/DELETE, dashboard GET/DELETE, channel DELETE, revoking the other org's key | all refused, nothing changed |
| Org boundaries | `x-monitoring-org` / `dd-org-id` headers can't redirect a write to another org | B's key wrote only into B |
| Org boundaries | unauthenticated UI/API and intake requests | 401 / 403 |
| Key revocation | key works, is revoked, and the next request (4 ms later) is refused on OTLP and on the Datadog Agent intake | 200 → 403 / 403 |
| Malformed payloads | garbage and truncated protobuf, invalid JSON, wrong content type → 400; 60 MB body → 413; gzip bomb (100 KB → 1 GB) → 413; 100k-level nested JSON, 10 MB attribute, NaN/Infinity, negative/far-future timestamps → accepted and bounded; server healthy after each | no 5xx |
| Malformed payloads | server memory after the whole set | 122 → 210 MB |
| Malformed payloads | 10 MB attribute value | stored truncated to 25,000 chars |
| Redaction | card number, bearer token, AWS key, JWT, `password=`, a `user.password` attribute, an `authorization` header attribute, `api_key=` in a URL | all stored as `[REDACTED:*]` |
| Redaction | ordinary values (`order 1234`, `ord-555`, `amount=10`) | untouched |

The org boundaries are checked on 15 read surfaces:
- APM services list and service page
- span search (by service, and `*`)
- trace by ID
- log search, full-text search and facets
- metric names and metric query
- host list
- monitor, dashboard and channel lists
- org keys

## What the first run found, and the fixes

The first run passed 11 of 13 checks:

- **Unbounded request bodies.** A 60 MB body was accepted (the raw intake limit was 64 MB), and server memory grew from 75 MB to 1,184 MB.
  - **Fix:** intake bodies are now capped at `MONITORING_MAX_BODY_MB` (default 16; the OpenTelemetry Collector uses 20 MiB), and decompressed size at `MONITORING_MAX_DECOMPRESSED_MB` (default 64). Both answer 413.
- **Oversized values stored whole.** A 10 MB attribute value was saved in full.
  - **Fix:** span and log attribute values are truncated at `MONITORING_MAX_ATTRIBUTE_CHARS` (default 25,000) and log messages at `MONITORING_MAX_LOG_MESSAGE_CHARS` (default 262,144). Records keep at most 500 attributes.

## Sensitive-data redaction (new)

`artifacts/api-server/src/intake/redact.ts` masks values in every log and span before storage. It covers all intake paths (OTLP, Datadog Agent and tracer, agent and agentless).

| Rule | Default | Example |
| --- | --- | --- |
| Payment card numbers (Luhn-checked, spaces/dashes allowed) | on | `4111 1111 1111 1111` → `[REDACTED:card]` |
| `Bearer` / `Basic` credentials | on | `Bearer eyJ…` → `Bearer [REDACTED:bearer]` |
| Secret key/value pairs (`password=`, `token:`, `api_key=` …) | on | `password=hunter2` → `password=[REDACTED:secret]` |
| AWS access key IDs | on | `AKIA…` → `[REDACTED:aws_key]` |
| JWTs, PEM private keys | on | `[REDACTED:jwt]`, `[REDACTED:private_key]` |
| Attributes whose name looks secret (`password`, `secret`, `token`, `api_key`, `authorization`, `cookie` …) | on | value → `[REDACTED:key]` |
| Email addresses | off (`MONITORING_REDACT_EMAILS=true`) | `[REDACTED:email]` |
| Custom regexes | `MONITORING_REDACT_PATTERNS='re1;;re2'` | `[REDACTED:custom]` |
| Extra attribute names | `MONITORING_REDACT_KEYS='ssn,dob'` | `[REDACTED:key]` |
| Everything off | `MONITORING_REDACTION=off` | |

A cheap pre-check skips the regexes for strings that can't contain a match. The ramp test measures intake throughput with redaction on.

**Limits:**
- Redaction runs at intake, so values are still in transit from app to server, over TLS when configured.
- Already-stored data is not rewritten.
- Free-text personal data such as names and addresses is not detected. Use custom patterns, or keep such data out of telemetry.

# Experimental Agent metric custody

This is an off-by-default, finite experiment for Node DELTA sums and gauges through the Monitoring Agent to PostgreSQL. It is not a production delivery guarantee. Ordinary SDK/Collector delta delivery still has response-loss duplication defects. This experiment does not change those defaults.

A custody acknowledgement means immutable bytes were durably accepted by the local Agent journal. It does **not** mean the backend stored any points. Only backend acceptance or a matching backend receipt confirms storage.

## Required selection

The Agent configuration must explicitly enable the experiment and name a loopback listener:

```yaml
api_key: ${MONITORING_API_KEY}
url: http://127.0.0.1:3000
state_dir: /var/lib/monitoring-agent
metric_custody_test:
  enabled: true
  endpoint: 127.0.0.1:4438
```

Use the actual endpoint and configuration file for the running Agent. The CLI never starts an Agent or opens its journal. A disabled configuration, a non-IP hostname, an external address, redirects, a missing API key or a zero port is refused. Credentials are read from the same configuration, including its explicit environment-variable reference, and are not printed or included in command arguments.

The Node app separately selects `MONITORING_METRIC_CUSTODY_TEST_ONLY=yes` and `MONITORING_METRIC_CUSTODY_URL=http://127.0.0.1:4438`, with its API key. Additional metric retries must remain off, and the separate direct experiment must be off. The PostgreSQL backend must explicitly enable its direct-delivery experiment and custody reports. None of these flags should be set in an ordinary production installation.

## Inspect the running Agent

```sh
monitoring-agent custody status -c /etc/monitoring/monitoring.yaml
```

This makes authenticated, bounded requests only to the configured local Agent. Output contains the current journal epoch, input IDs, finite deadlines, retained byte count, attempts, journal bounds, retired lease counts and custody/backend-storage state. It omits metric bytes, hashes, API keys and backend tokens.

- `issued`: an input identity exists, but the Agent has no custody of bytes.
- `custody`: the Agent holds bytes; backend storage is unconfirmed.
- `blocked`: retained state needs an explicit recovery request after fixing the connection, key or quota.
- `stored`: the Agent reports backend acceptance or receipt confirmation. The authenticated backend view separately matches current backend receipts.
- `expired-unconfirmed`: do not resend those deltas under another identity. An expired receipt is not proof that the points were absent.

The backend status view may be stale and cannot replay Agent bytes. An unavailable local Agent is also not evidence of storage or loss.

## Request recovery of one original input

Copy the exact input ID and journal epoch from status, then explicitly select that original input:

```sh
monitoring-agent custody recover --id INPUT_ID --epoch JOURNAL_EPOCH -c /etc/monitoring/monitoring.yaml
```

`INPUT_ID` and `JOURNAL_EPOCH` must each be the exact 32-character lowercase hexadecimal value. The CLI checks the current protocol and epoch and reads the original receipt before requesting recovery. It does not issue leases, create identities or replace a journal. Already-stored input is returned without requesting another recovery. Missing, expired, mismatched or non-blocked input is refused with an inspection message.

A successful command means the local Agent accepted a recovery request, **not** that the backend stored anything. Run `custody status` again to inspect the later outcome. The Agent first reconciles the original backend receipt. Any eligible data send uses the original persisted bytes and token. Once backend eligibility ends, reconciliation cannot authorize a new data send or token. Normal Agent startup and `custody status` never request recovery.

## Finite limits

- 30-second input-admission window.
- Input receipt/journal retention ends 5 minutes after that input window, not an unlimited offline spool.
- At most 128 retained input entries and 16 MiB of payload; each body at most 1 MiB.
- Physical journal file cap 128 MiB. Freed pages can be reused, but the allocated file does not shrink. Availability under arbitrary lifetime fragmentation is not proven.
- One initial backend metric send and at most 3 total sends with explicit recovery. Receipt reconciliation may still confirm a prior result after the send budget is exhausted, while its receipt remains available.
- Backend test eligibility and receipt grace are each 30 seconds. These are experimental constants, not a production outage-retention promise.

A full journal refuses new custody instead of erasing acknowledged pending bytes. Retired unconfirmed/refused lease counts are not counts of lost measurements. Unsent app memory is not durably spooled, and app exit before custody remains a data-loss gap. Journal replacement creates a new epoch and must not reaccept old inputs. Process-crash evidence does not prove hardware power-loss safety.

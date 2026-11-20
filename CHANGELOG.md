# Changelog

## 0.1.0 (unreleased)

First public release.

- Server and web UI: metrics explorer, dashboards, logs with live tail, APM with trace waterfalls, infrastructure,
  monitors with webhook and Slack notifications, organizations, local accounts and invite links.
- Telemetry storage in PostgreSQL (default) or ClickHouse.
- Intake: OpenTelemetry (OTLP/HTTP), the Datadog Agent (tested with 7.56.2 and 7.85.4) and Datadog's open-source
  tracers.
- Monitoring Agent (an OpenTelemetry Collector distribution) and the `@monitoring/trace` (Node.js) and `monitoring-trace`
  (Python) libraries.

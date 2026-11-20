# Security policy

## Reporting vulnerabilities

Do not post credentials, exploitable details or real telemetry in public issues.
Use the repository's **Security → Report a vulnerability** private advisory feature.
If private reporting is unavailable, contact a maintainer privately to arrange a
secure channel before disclosing details. There is currently no guaranteed response
SLA; deployments should track the latest release and their dependency advisories.

## Deployment responsibilities

- Complete initial admin setup on a private interface before public exposure.
- Use TLS, a stable `PUBLIC_URL`, a random `SESSION_SECRET` (at least 32 characters),
  network firewall rules and a trusted reverse proxy. Proxy headers (`X-Forwarded-*`) are
  ignored unless `MONITORING_TRUST_PROXY` is set; set it only when Monitoring is reachable solely through that proxy.
- Keep PostgreSQL private and patched. Encrypt disks/backups and restrict DB access.
- Treat API keys, single-use invite links, session tokens and webhook credentials as
  secrets. Revoke keys/invites if shared accidentally. Do not log sensitive payloads.
- Local passwords are scrypt hashes; login is rate-limited per IP. Add edge rate
  limits for internet-facing installations. There is no built-in MFA or password
  reset email service. Prefer a controlled private deployment for sensitive workloads.
- Administrators and members can configure telemetry and notification destinations.
  Restrict network egress and webhook access; do not allow untrusted organization
  members to reach internal metadata or privileged services through a webhook URL.
- Telemetry may contain personal data or credentials supplied by applications.
  Redact at the source, limit collection, and configure retention appropriately.
- Agent OTLP/StatsD/compatible intake is local by default. Do not expose unauthenticated
  local receiver ports outside the trusted host/network.
- Verify release checksums and use HTTPS. Checksums do not replace trusted publishing
  or signatures. Review installer scripts before running them with elevated privileges.

## Repository hygiene

CI scans the full history for secrets with gitleaks. Never commit `.env`, database
dumps, generated binaries, local benchmark output or private endpoint URLs. Third-party libraries retain their own
licenses; review dependencies and provenance separately from Monitoring's license.

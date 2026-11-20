# Modifications

This product, "Monitoring", is adapted from the Apache-2.0-licensed project
described in NOTICE. Original copyright notices, LICENSE, NOTICE and
third-party attribution files are preserved unchanged.

Changes made after 2026-11-20 (also recorded in git history):

1. Product renamed to "Monitoring" across the UI, docs, packaging and
   configuration, including a new pulse logo and favicon (legal
   NOTICE/attribution files intentionally unchanged).
2. Multi-organization membership: users can belong to multiple organizations
   via a new org_memberships table with per-organization roles and an active
   organization switcher (previously one organization per user).
3. Per-organization ingestion quotas and usage metering with enforcement at
   intake (atomic Postgres reservations, safe across multiple server
   processes), plus a Usage & Limits admin view.
4. Generic OIDC single sign-in (authorization code + PKCE): identities and
   organization memberships bind to immutable (issuer, subject) and
   (issuer, external organization id) pairs, id_tokens are verified
   (signature/iss/aud/exp/iat/nonce), provider-derived grants are
   synchronized fail-closed with issuance-time ordering, and SSO sessions
   have a bounded absolute lifetime.
5. API key handling: keys are shown only once at creation and never returned
   by routine API/UI responses afterwards; agent onboarding uses an explicit
   create-once install flow; the install placeholder is shell-safe.
6. Resilience: the server now survives a Postgres restart (pg pool error
   handling instead of process crash); existing databases gain
   logs.attributes/trace_id through migration 9.
7. Backup/restore tooling, an alerting journey test, security benches
   (membership isolation, OIDC adversarial cases), scale and server-only
   resilience load harnesses under bench/.

Modified files carry these changes in git history; this file satisfies the
Apache-2.0 Section 4(b) modification-notice requirement for the distribution
as a whole.

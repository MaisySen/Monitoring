# Modifications

This product, "Monitoring", is adapted from the Apache-2.0-licensed project
described in NOTICE. Original copyright notices, LICENSE, NOTICE and
third-party attribution files are preserved unchanged.

Changes made after 2026-11-20 (also recorded in git history):

1. Product renamed to "Monitoring" across the UI, docs, packaging and
   configuration (legal NOTICE/attribution files intentionally unchanged).
2. Multi-organization membership: users can belong to multiple organizations
   via a new org_memberships table with per-organization roles and an active
   organization switcher (previously one organization per user).
3. Per-organization ingestion quotas and usage metering with enforcement at
   intake.
4. Backup/restore tooling and operational runbook additions.

Modified files carry these changes in git history; this file satisfies the
Apache-2.0 Section 4(b) modification-notice requirement for the distribution
as a whole.

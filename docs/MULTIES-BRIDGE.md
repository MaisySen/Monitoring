# Multies bridge design

How Monitoring fits the real Multies product, grounded in a read-only study of
`github.com/MaisySen/multies` (clone of 2026-11-20). Nothing in that repository was
modified; every contract below names the file it comes from.

## The Multies sign-in and workspace contract (as studied)

- **Auth stack**: better-auth with the organization plugin (`src/server/auth/options.ts`).
  Sign-in paths: local password, direct Google/GitHub in self-host, or an external IdP
  (Auth0) through better-auth's `genericOAuth` (`src/server/auth/providers.ts`).
  Multies is an OIDC *client*; it does not expose itself as an identity provider for
  third-party applications.
- **Workspaces**: `organizations`; membership in `members(organization_id, user_id, role)`
  with roles `owner` > `admin` > `member` (`drizzle/0005_better_auth.sql`,
  `src/server/auth/guards.ts:84`, `options.ts:307-333`). The workspace creator is `owner`;
  only the owner can invite admins; ownership is transferred, never shared.
- **Active workspace**: carried on the session row (`sessions.active_organization_id`,
  `drizzle/0005_better_auth.sql`), resolved in `resolveAuth`
  (`src/server/auth/guards.ts`) with fallback to the first membership. A cookie
  (`mymail.ws`, `src/server/auth/workspace-mark.ts`) busts per-isolate session caches so a
  workspace switch is visible at once everywhere.
- **Invitations**: `invitations(organization_id, email, role, status, expires_at)`; a new
  person whose verified email has a pending invitation joins that workspace on first
  sign-in (`guards.ts`, `joinPendingInviteOnFirstSignIn`).
- **Agent credentials**: workspace API keys (`mm_live_…`, `services/developer/api-keys.ts`)
  are org-scoped, hashed at rest, scoped `full` / `read` / per-area. A workspace key acts
  as a workspace admin on the v1 API. A person's session and an agent's key are never
  interchangeable (`guards.ts` header comment; `routes/v1.ts`).
- **OAuth 2.1 server** (`services/developer/oauth.ts`): dynamic client registration
  (RFC 7591, public clients, PKCE S256), hashed codes and refresh tokens, one-hour access
  tokens signed with an `APP_SECRET`-derived key. Today it issues only `mcp:read` /
  `mcp:write` scopes, and access tokens resolve only on the MCP guard
  (`routes/v1.ts` — `resolveOAuthToken` is called only when `isMcp`).
- **SSO enforcement**: a workspace can require SSO (`organizations.require_sso`); non-owner
  members who signed in with a non-SSO method are blocked (`auth/session.ts` `ssoBlocks`).

## How Monitoring's model already matches

Monitoring's multi-organization work was designed against an assumed contract; the study
confirms the real one is the same shape:

| Multies (studied) | Monitoring (implemented) |
| --- | --- |
| `members(org, user, role)` | `org_memberships(org, user, role)`, migration 4 |
| `sessions.active_organization_id` | session `activeOrgId`, `POST /api/ui/org/select` |
| roles owner/admin/member | roles admin/member (see mapping note below) |
| invite by email, auto-join on first sign-in | invite links + signed-in accept bound to account email |
| per-workspace API keys | per-organization API/application keys |

Role mapping for a bridge: Multies `owner` and `admin` map to Monitoring `admin`,
`member` maps to `member`. Monitoring's last-admin guard then protects the mapped owner.
Ownership transfer remains a Multies-side concept; Monitoring does not need to mirror it.

## Bridge options, in order of what works today

### B1. Connection validation record (no Multies changes; org-level only)

A Multies workspace admin pastes an `mm_live_…` key (scope `read` suffices) into the
Monitoring org's settings. Monitoring verifies it once, at that moment, by calling a
read endpoint of the Multies v1 API, then discards the raw key and keeps only its hash.
The record says exactly this: at validation time, an admin of this Monitoring org held a
working Multies workspace API key. Nothing more:

- It is **not a credential store**: the raw key is never persisted, so the record cannot
  authenticate any future outbound call to Multies. A functional reporting bridge (e.g.
  posting alert notifications into Multies chat) would need a separately approved,
  durably stored credential (approved vault handling), which this does not create.
- It is **not verified workspace identity**: the Multies v1 API proves key validity but
  exposes no workspace-identity endpoint, so the stored workspace label is self-declared
  by the admin and presented that way.
- It is *not* person sign-in and must never become one: an `mm_live_` key acts as the
  workspace admin, so accepting it as a user credential would hand workspace-admin power
  to any login.

### B2. Sign in with Multies via its OAuth 2.1 server (needs a small Multies change)

The natural person-level bridge is Monitoring as an OAuth client of Multies' existing
OAuth 2.1 server (the MCP one): dynamic registration and PKCE already exist. What is
missing is a scope beyond `mcp:*` and token resolution outside the MCP guard — a small,
additive Multies change (new scope, e.g. `identity:read`, returning user id/email plus
workspace membership and role). That change is a **Multies write and stays out of scope
until the user authorizes it**.

The Monitoring half of this — a generic OIDC authorization-code + PKCE sign-in — is
provider-independent and is built and tested locally against stub identity providers
(see `bench/security/oidc.js`). Its tenant-isolation rules, enforced and tested:

- Identity binds to the immutable `(issuer, sub)` pair (`sso_identities`). An email
  claim never links a login to an existing account, so a provider asserting someone
  else's address cannot inherit their privileges.
- Organizations bind to `(issuer, external workspace id)` (`sso_org_bindings`). Display
  names are rendering only, never lookup keys: a same-named workspace from any issuer
  cannot land a user in the wrong organization.
- id_tokens are verified properly: RS256 signature against the provider JWKS, plus
  issuer, audience, expiry and nonce checks.
- Provider role claims sync only `sso`-sourced memberships on each login: downgrades
  and removals apply, locally granted roles always stand. The sync fails closed: a
  revoked grant is never retained, even when it leaves the organization without an
  admin. Recovery then requires a separately authorized local grant, not stale SSO
  privilege.
- Claim syncs apply strictly in claim-issuance order (id_token `iat`; `auth_time`
  dates the provider login, not the claims, and is never used for ordering). A
  callback carrying strictly older claims creates its session but never re-applies
  them; an equal-`iat` tie fails closed, applying removals and downgrades but never
  grants or upgrades, so a timestamp collision cannot restore revoked authority.
- Provider contract requirement: the provider MUST resolve workspace claims at
  token-exchange time, so every fresh login re-reads current membership even on a
  long-lived provider session. This is a requirement on B2's future Multies half.
- Freshness bound: provider changes apply at the user's next SSO login (there is no
  push revocation channel). To keep that bound finite, SSO sessions expire after
  `MONITORING_OIDC_SESSION_TTL_HOURS` (default 12h) and expiry fails closed: the user
  re-authenticates, which re-syncs. Between syncs, every existing session converges
  immediately after any login, because roles and memberships are read from the
  database per request, never cached in the session. Worst case for a revoked grant
  reaching a never-relogging session is therefore the session TTL.

When Multies exposes the scope, pointing Monitoring at it is configuration, not new
code.

### B3. Deep embedding (iframe/navigation from the Multies shell)

Only after B2. Not designed further here; it depends on Multies front-end work.

## What this rules out

- **Shared session cookies**: Multies sessions live in its own database with its own
  cookie; Monitoring never reads them. Cross-app cookies would also couple the two
  deployment origins.
- **Reading Multies' database directly**: never. All verification goes through its HTTP
  API surface.
- **Assuming "Sign in with Multies" exists today**: it does not; only the MCP-scoped
  OAuth server does.

## Status

- B1: Monitoring half implemented and tested against a stub Multies v1 API
  (bench/security/multies-bridge.js, 11/11): the connection check verifies the key once
  against GET /api/v1/domains, stores only its sha256 hash, redacts it in reads, is
  admin-only to write, replaces on re-validation, deletes cleanly, and refuses
  private/local Multies URLs unless MONITORING_ALLOW_PRIVATE_WEBHOOKS is set. Live
  verification against a real Multies deployment remains an external dependency.
- B2 Monitoring half: implemented and tested locally (OIDC sign-in); Multies half blocked
  on Multies write authority.
- B3: not started.

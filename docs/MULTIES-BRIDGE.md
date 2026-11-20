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

### B1. Workspace binding by API key (no Multies changes; org-level only)

A Multies workspace admin pastes an `mm_live_…` key (scope `read` suffices) into the
Monitoring org's settings. Monitoring verifies it by calling a read endpoint of the
Multies v1 API and records the binding (Multies workspace id ↔ Monitoring org id) plus
the key hash. This proves the same people operate both sides and enables later per-org
integrations (e.g. posting alert notifications into Multies chat). It is *not* person
sign-in: keys act as the workspace, not as a user.

### B2. Sign in with Multies via its OAuth 2.1 server (needs a small Multies change)

The natural person-level bridge is Monitoring as an OAuth client of Multies' existing
OAuth 2.1 server (the MCP one): dynamic registration and PKCE already exist. What is
missing is a scope beyond `mcp:*` and token resolution outside the MCP guard — a small,
additive Multies change (new scope, e.g. `identity:read`, returning user id/email plus
workspace membership and role). That change is a **Multies write and stays out of scope
until the user authorizes it**.

The Monitoring half of this — a generic OIDC/OAuth authorization-code + PKCE sign-in
that provisions the user and maps provider workspace claims onto `org_memberships` — is
provider-independent and is built and tested locally against a stub identity provider
(see `bench/security/oidc.js`). When Multies exposes the scope, pointing Monitoring at it
is configuration, not new code.

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

- B1: designed; not yet implemented (needs a live Multies deployment to verify against —
  external dependency).
- B2 Monitoring half: implemented and tested locally (OIDC sign-in); Multies half blocked
  on Multies write authority.
- B3: not started.

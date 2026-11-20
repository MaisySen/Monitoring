/**
 * Generic OIDC/OAuth2 sign-in (authorization code + PKCE, S256). This is the
 * provider-independent half of the Multies bridge (docs/MULTIES-BRIDGE.md, option B2):
 * any provider that issues an authorization code and answers userinfo with a verified
 * email can sign people in; when the provider carries workspace claims (`orgs`), they are
 * mapped onto Monitoring memberships.
 *
 * Enabled when MONITORING_OIDC_ISSUER and MONITORING_OIDC_CLIENT_ID are set:
 *   MONITORING_OIDC_ISSUER        provider base URL (discovery at <issuer>/.well-known/openid-configuration)
 *   MONITORING_OIDC_CLIENT_ID     client id
 *   MONITORING_OIDC_CLIENT_SECRET optional; public clients use PKCE only
 *   MONITORING_OIDC_SCOPE         default "openid email profile"
 * Discovery is fetched once and cached for 5 minutes.
 *
 * The PKCE verifier and state ride in a short-lived HMAC-signed cookie, so the flow works
 * across any number of server processes without a shared table.
 */
import crypto from "node:crypto";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  scope: string;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = (env.MONITORING_OIDC_ISSUER ?? "").replace(/\/+$/, "");
  const clientId = env.MONITORING_OIDC_CLIENT_ID ?? "";
  if (!issuer || !clientId) return null;
  if (!/^https?:\/\//.test(issuer)) throw new Error("MONITORING_OIDC_ISSUER must be an http(s) URL");
  return {
    issuer,
    clientId,
    clientSecret: env.MONITORING_OIDC_CLIENT_SECRET || null,
    scope: env.MONITORING_OIDC_SCOPE || "openid email profile",
  };
}

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

let cached: { at: number; ep: Endpoints } | null = null;

export async function discover(cfg: OidcConfig): Promise<Endpoints> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.ep;
  const r = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status}`);
  const j = (await r.json()) as Partial<Endpoints>;
  if (!j.authorization_endpoint || !j.token_endpoint || !j.userinfo_endpoint)
    throw new Error("OIDC discovery document is missing endpoints");
  cached = { at: Date.now(), ep: j as Endpoints };
  return cached.ep;
}

const b64url = (b: Buffer) => b.toString("base64url");
const s256 = (s: string) => b64url(crypto.createHash("sha256").update(s).digest());

export interface PkceState {
  state: string;
  verifier: string;
  exp: number;
}

export function startPkce(): { state: string; challenge: string; cookiePayload: string } {
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const payload: PkceState = { state, verifier, exp: Date.now() + 10 * 60_000 };
  return { state, challenge: s256(verifier), cookiePayload: JSON.stringify(payload) };
}

export function authorizeUrl(ep: Endpoints, cfg: OidcConfig, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(ep.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Signs the PKCE cookie so no server-side state table is needed (HMAC with the session secret). */
export function sealPkce(payload: string, secret: string): string {
  const mac = crypto.createHmac("sha256", `oidc:${secret}`).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function openPkce(sealed: string, secret: string): PkceState | null {
  const i = sealed.lastIndexOf(".");
  if (i < 0) return null;
  const body = sealed.slice(0, i);
  const mac = sealed.slice(i + 1);
  let payload: string;
  try {
    payload = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const want = crypto.createHmac("sha256", `oidc:${secret}`).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(payload) as PkceState;
    if (typeof p.state !== "string" || typeof p.verifier !== "string" || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

export interface OidcIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  orgs: { id: string; name: string; role: string }[];
}

export async function exchangeCode(
  ep: Endpoints,
  cfg: OidcConfig,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<OidcIdentity> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(ep.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cfg.clientSecret ? { authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` } : {}),
    },
    body,
  });
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  const tok = (await r.json()) as { access_token?: string };
  if (!tok.access_token) throw new Error("token response has no access_token");
  const ui = await fetch(ep.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` } });
  if (!ui.ok) throw new Error(`userinfo failed: HTTP ${ui.status}`);
  const p = (await ui.json()) as Record<string, unknown>;
  const email = String(p.email ?? "").trim().toLowerCase();
  if (!p.sub || !email || !email.includes("@")) throw new Error("userinfo is missing sub or email");
  if (p.email_verified === false) throw new Error("provider reports the email is not verified");
  const orgs = Array.isArray(p.orgs)
    ? (p.orgs as any[])
        .filter((o) => o && typeof o.name === "string" && o.name.trim())
        .map((o) => ({ id: String(o.id ?? o.name), name: String(o.name).trim(), role: o.role === "admin" || o.role === "owner" ? "admin" : "member" }))
    : [];
  return { sub: String(p.sub), email, emailVerified: p.email_verified !== false, name: typeof p.name === "string" ? p.name : null, orgs };
}

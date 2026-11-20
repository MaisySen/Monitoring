import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isBlockedAddress, makeSafeLookup } from "./safeHttp";

// Uptime probing. Destinations get the same SSRF constraints as outbound webhooks: http(s)
// only, no credentials in the URL, and private, loopback, link-local and reserved addresses
// refused both for IP literals and for every address a hostname resolves to at connect time.
// Unlike webhooks, redirects ARE followed (sites commonly bounce http->https or bare->www),
// but every hop is re-validated before connecting, so a public URL cannot bounce the probe
// into the internal network.
//
// MONITORING_UPTIME_ALLOW_PRIVATE=1 lifts the private-address refusal. It exists ONLY so
// tests and disposable local targets can be probed; never set it in a real deployment. It is
// deliberately a separate flag from MONITORING_ALLOW_PRIVATE_WEBHOOKS so that allowing
// internal webhooks does not silently allow internal probes.
const allowPrivate = String(process.env.MONITORING_UPTIME_ALLOW_PRIVATE ?? "false").toLowerCase() === "true";
export const uptimeAllowsPrivate = allowPrivate;

const safeLookup = makeSafeLookup(allowPrivate);

export const MAX_REDIRECTS = 3;
export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 3600;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 30000;
export const MAX_CHECKS_PER_ORG = 50;
/** Per-org manual probe runs per minute (POST /ui/uptime/:id/run). */
export const MANUAL_RUNS_PER_ORG_PER_MIN = 10;
/** Per-org cap on checks claimed in one loop tick (global tick claim is CLAIM_LIMIT in jobs/uptime). */
export const MAX_CHECKS_CLAIMED_PER_ORG_PER_TICK = 5;

/** Resolves a redirect Location against its base URL and validates the hop like any target. */
export function nextHopUrl(location: string, base: URL): URL {
  return checkUptimeUrl(new URL(location, base).toString());
}

/** Throws (status 400) when the URL is not a plain http(s) URL or points at a refused address. */
export function checkUptimeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("URL must be a valid http(s) URL"), { status: 400 });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw Object.assign(new Error("URL must start with http(s)://"), { status: 400 });
  if (u.username || u.password)
    throw Object.assign(new Error("Credentials are not allowed in uptime URLs"), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const refused = new Error(
    "Uptime targets on private or local addresses are disabled (MONITORING_UPTIME_ALLOW_PRIVATE is a test-only override)",
  );
  if (net.isIP(host) && isBlockedAddress(host, allowPrivate)) throw Object.assign(refused, { status: 400 });
  if (!allowPrivate && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))
    throw Object.assign(refused, { status: 400 });
  return u;
}

export interface UptimeProbeResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
  redirects: number;
  finalUrl: string;
}

interface HopResult {
  status: number;
  location: string | null;
}

/**
 * One request. The probe only needs the response headers to judge availability, so the body
 * is never read: the request is destroyed as soon as headers arrive (duration = time to
 * headers). A trickling or huge body can never hold the probe open, and the inactivity
 * timeout plus the caller's total deadline bound the whole exchange.
 */
function probeOnce(u: URL, method: "GET" | "HEAD", timeoutMs: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method,
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: { "user-agent": "Monitoring-Uptime/1.0", accept: "*/*", connection: "close" },
      },
      (res) => {
        const out: HopResult = {
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === "string" ? res.headers.location.slice(0, 2048) : null,
        };
        res.resume();
        req.destroy();
        resolve(out);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    req.end();
  });
}

function describeError(e: any): string {
  if (e?.code === "EBLOCKED") return "refused: target resolves to a private or local address";
  if (e?.code === "ETIMEDOUT") return "timeout";
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return "name resolution failed";
  if (e?.code) return String(e.code);
  return String(e?.message ?? e ?? "probe failed").slice(0, 200);
}

export interface ProbeOptions {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  expectMin?: number;
  expectMax?: number;
}

/** Fixed-window rate limiter (per key), in-memory per process. Bounds manual probe runs. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  allow(key: string, now: number = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

export async function probeUptime(raw: string, opts: ProbeOptions = {}): Promise<UptimeProbeResult> {
  const method = opts.method === "HEAD" ? "HEAD" : "GET";
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 8000, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const expectMin = opts.expectMin ?? 200;
  const expectMax = opts.expectMax ?? 399;
  const start = Date.now();
  const deadline = start + timeoutMs;
  let u = checkUptimeUrl(raw);
  let redirects = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, status: null, durationMs: Date.now() - start, error: "timeout", redirects, finalUrl: u.toString() };
    }
    let hop: HopResult;
    try {
      hop = await probeOnce(u, method, remaining);
    } catch (e: any) {
      return {
        ok: false,
        status: null,
        durationMs: Date.now() - start,
        error: describeError(e),
        redirects,
        finalUrl: u.toString(),
      };
    }
    if (hop.status >= 300 && hop.status < 400 && hop.location) {
      if (redirects >= MAX_REDIRECTS) {
        return {
          ok: false,
          status: hop.status,
          durationMs: Date.now() - start,
          error: `too many redirects (>${MAX_REDIRECTS})`,
          redirects,
          finalUrl: u.toString(),
        };
      }
      redirects++;
      let next: URL;
      try {
        next = nextHopUrl(hop.location, u);
      } catch (e: any) {
        return {
          ok: false,
          status: hop.status,
          durationMs: Date.now() - start,
          error: `redirect refused: ${e?.message ?? "invalid target"}`,
          redirects,
          finalUrl: u.toString(),
        };
      }
      u = next;
      continue;
    }
    const ok = hop.status >= expectMin && hop.status <= expectMax;
    return {
      ok,
      status: hop.status,
      durationMs: Date.now() - start,
      error: ok ? null : `status ${hop.status} outside expected ${expectMin}-${expectMax}`,
      redirects,
      finalUrl: u.toString(),
    };
  }
}

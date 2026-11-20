import zlib from "zlib";
import type { Request } from "express";

// Decompressed payloads are capped (MONITORING_MAX_DECOMPRESSED_MB, default 64 MB) so a small "zip bomb" cannot exhaust
// memory; exceeding it throws PayloadTooLarge, which the intake routes answer with 413.
const MAX_OUT = Number(process.env.MONITORING_MAX_DECOMPRESSED_MB ?? 64) * 1024 * 1024;
const LIMIT = { maxOutputLength: MAX_OUT };
export class PayloadTooLarge extends Error {
  status = 413;
}
function tooLarge(e: any): never | void {
  if (e?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|Cannot create a Buffer larger/i.test(String(e?.message)))
    throw new PayloadTooLarge(`Decompressed payload exceeds ${MAX_OUT >> 20} MB`);
}

export function decompress(req: Request): Buffer {
  let buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
  const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
  if (!buf.length) return buf;
  try {
    if (enc.includes("zstd")) return zlib.zstdDecompressSync(buf, LIMIT);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf, LIMIT);
    if (enc.includes("deflate")) {
      try {
        return zlib.inflateSync(buf, LIMIT);
      } catch {
        return zlib.inflateRawSync(buf, LIMIT);
      }
    }
  } catch (e) {
    tooLarge(e);
    // otherwise fall through to sniffing
  }
  // sniff magic numbers
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf, LIMIT);
  if (buf[0] === 0x78 && (buf[1] === 0x9c || buf[1] === 0x01 || buf[1] === 0xda || buf[1] === 0x5e)) {
    try {
      return zlib.inflateSync(buf, LIMIT);
    } catch {}
  }
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) return zlib.zstdDecompressSync(buf, LIMIT);
  return buf;
}

export function parseJson(buf: Buffer): any {
  const s = buf.toString("utf8").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // newline-delimited JSON
    return s
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { message: l };
        }
      });
  }
}

export function apiKeyFrom(req: Request): string | undefined {
  return (
    (req.headers["dc-api-key"] as string) ||
    (req.headers["dd-api-key"] as string) ||
    /^Bearer\s+(\S+)$/i.exec(String(req.headers["authorization"] ?? ""))?.[1] ||
    (req.query["api_key"] as string) ||
    (req.query["dd-api-key"] as string) ||
    undefined
  );
}

// Terminal color and cursor sequences (e.g. colored framework access logs) make stored messages unreadable.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export function stripAnsi(s: string): string {
  return s.includes("\x1b") ? s.replace(ANSI, "") : s;
}

/** Tag helpers */
export function tagValue(tags: string[], key: string): string | undefined {
  const p = key + ":";
  const t = tags.find((t) => t.startsWith(p));
  return t ? t.slice(p.length) : undefined;
}

/**
 * Normalize a trace ID to the decimal 64-bit form spans are stored under. Tracers inject 128-bit hex IDs
 * into logs by default (e.g. "6af3a5a8000000005604429f91823c79"); the low 64 bits are the span trace ID.
 */
export function normalizeTraceId(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return BigInt(s) > 0xffffffffffffffffn ? (BigInt(s) & 0xffffffffffffffffn).toString() : s;
  if (/^(0x)?[0-9a-f]{1,32}$/i.test(s)) {
    const hex = s.replace(/^0x/i, "");
    return BigInt("0x" + hex.slice(-16)).toString();
  }
  return s;
}

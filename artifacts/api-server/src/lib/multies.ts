import crypto from "node:crypto";
import { getChecked } from "./safeHttp";

// B1 Multies connection validation (docs/MULTIES-BRIDGE.md): a workspace admin pastes an mm_live_ key and
// we verify it once against the Multies v1 API, keep only its hash, and discard the raw value. The stored
// record is a connection-validation record - proof that an admin held a working key at validation time.
// It is NOT a credential store (nothing here can authenticate a future Multies call), NOT verified
// workspace identity (the v1 API has no whoami; the label is self-declared), and never a sign-in path
// (an mm_live_ key acts as the workspace admin).

export function hashBindingKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Probes the Multies v1 API with the key. Throws a status-carrying Error when the key is not usable. */
export async function verifyMultiesKey(baseUrl: string, key: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  let status: number;
  try {
    ({ status } = await getChecked(`${origin}/api/v1/domains`, { authorization: `Bearer ${key}` }));
  } catch (e: any) {
    if (e?.status) throw e; // destination validation (private/local address) refusal
    throw Object.assign(new Error("Could not reach that Multies URL"), { status: 400 });
  }
  if (status === 401 || status === 403)
    throw Object.assign(new Error("Multies rejected that API key"), { status: 400 });
  if (status < 200 || status >= 300)
    throw Object.assign(new Error(`Multies verification failed (HTTP ${status})`), { status: 400 });
}

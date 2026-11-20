import crypto from "node:crypto";
import { getChecked } from "./safeHttp";

// B1 Multies bridge (docs/MULTIES-BRIDGE.md): a workspace admin pastes an mm_live_ key and we verify it
// against the Multies v1 API. The Multies API proves the key is valid and org-scoped, but it exposes no
// "whoami" endpoint, so it cannot tell us WHICH workspace the key belongs to - the workspace label stored
// with the binding is self-declared by the admin and must be presented that way.
//
// A binding is never a sign-in path: an mm_live_ key acts as the workspace admin, so accepting it as a
// user credential would hand workspace-admin power to any login. It is verified once, hashed, and the
// raw value is never stored.

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

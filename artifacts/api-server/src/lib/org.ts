import { logger } from "./logger";
import crypto from "crypto";
import { db, orgsTable, orgMembershipsTable, apiKeysTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { AuthUser } from "./auth";

export function newKey(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

export interface OrgUser extends AuthUser {
  orgId: number;
  orgName: string;
  role: string;
}

export interface OrgMembership {
  orgId: number;
  orgName: string;
  role: string;
}

/** Every organization the user belongs to, with their role in each, ordered by organization id. */
export async function listMemberships(userId: string): Promise<OrgMembership[]> {
  const rows = await db
    .select({ orgId: orgMembershipsTable.orgId, orgName: orgsTable.name, role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .innerJoin(orgsTable, eq(orgsTable.id, orgMembershipsTable.orgId))
    .where(eq(orgMembershipsTable.userId, userId));
  return rows.sort((a, b) => a.orgId - b.orgId);
}

/**
 * The user's organization and role, or null when the account is not a member of one. When requestedOrgId is
 * set (the session's active organization), that membership is used; if it no longer exists, the first
 * membership is used instead so a removed membership never strands a signed-in user.
 */
export async function resolveMembership(user: AuthUser, requestedOrgId?: number | null): Promise<OrgUser | null> {
  const memberships = await listMemberships(user.id);
  if (!memberships.length) return null;
  const chosen = (requestedOrgId != null && memberships.find((m) => m.orgId === requestedOrgId)) || memberships[0];
  return { ...user, orgId: chosen.orgId, orgName: chosen.orgName, role: chosen.role };
}

/** Add a user to an organization; an existing membership keeps its current role. */
export async function addMembership(userId: string, orgId: number, role: string): Promise<void> {
  await db.insert(orgMembershipsTable).values({ userId, orgId, role }).onConflictDoNothing();
}

/** Number of admins in an organization; used to protect the last admin. */
export async function countOrgAdmins(orgId: number): Promise<number> {
  const rows = await db
    .select({ userId: orgMembershipsTable.userId })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.orgId, orgId), eq(orgMembershipsTable.role, "admin")));
  return rows.length;
}

const keyCache = new Map<string, { orgId: number; kind: string; at: number }>();

export async function orgForApiKey(key: string | undefined | null): Promise<number | null> {
  if (!key) return null;
  const c = keyCache.get(key);
  if (c && Date.now() - c.at < 60_000) return c.orgId;
  const [row] = await db
    .select()
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.key, key), eq(apiKeysTable.kind, "api"), eq(apiKeysTable.revoked, false)));
  if (!row) return null;
  keyCache.set(key, { orgId: row.orgId, kind: row.kind, at: Date.now() });
  db.update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, row.id))
    .catch((e) => logger.debug({ err: String(e) }, "api key last_used_at update failed"));
  return row.orgId;
}

export function invalidateKey(key: string) {
  keyCache.delete(key);
}

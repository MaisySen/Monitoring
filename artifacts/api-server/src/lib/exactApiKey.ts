// Unregistered exact-key lookup only. Caller supplies an already-BEGIN'd dedicated
// client and OWNS its transaction/rollback/release. This helper NEVER starts or
// ends a transaction and is NOT acceptance authority outside that transaction.
// No pool, ordinary orgForApiKey/cache, lastUsedAt writes, telemetry or retry.
export interface CallerOwnedKeyTransaction {
  query(sql: string, values: unknown[]): Promise<{ rows: { id: number; orgId: number }[] }>;
}
export interface ExactApiKeyIdentity { id: number; orgId: number }
export async function lockExactActiveApiKey(
  transaction: CallerOwnedKeyTransaction,
  rawKey: string,
  expected?: ExactApiKeyIdentity,
): Promise<ExactApiKeyIdentity | null> {
  if (typeof rawKey !== "string" || !rawKey.length || rawKey.length > 64) return null;
  if (expected && (!Number.isSafeInteger(expected.id) || expected.id <= 0 || !Number.isSafeInteger(expected.orgId) || expected.orgId <= 0)) return null;
  // Active predicate is part of the locking statement so READ COMMITTED
  // rechecks a revoke that wins first. FOR KEY SHARE is deliberately NOT used.
  const result = await transaction.query(
    `select id, org_id as "orgId" from api_keys
     where key=$1 and kind='api' and revoked=false
       and ($2::integer is null or id=$2) and ($3::integer is null or org_id=$3)
     for share`,
    [rawKey, expected?.id ?? null, expected?.orgId ?? null],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.orgId) || row.orgId <= 0) throw new Error("Invalid exact-key identity result");
  return { id: row.id, orgId: row.orgId };
}

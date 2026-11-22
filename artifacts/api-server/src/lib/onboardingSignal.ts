import { pool } from "@workspace/db";
import { useClickHouse } from "./storage";

export const onboardingLabel = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(v);

// Exact service/environment match, never org-wide traffic from unrelated identities.
export async function onboardingSignal(orgId: number, service: string, env: string, now = Date.now()) {
  if (useClickHouse) return { supported: false, service, env, receiving: false, reason: "Targeted setup checks are unavailable for this storage backend." };
  const since = now - 5 * 60_000;
  const r = (
    await pool.query(
      `select t.traces,t.last_trace,l.logs,l.last_log from
         (select count(*) as traces,max(start_ms) as last_trace from spans where org_id=$1 and service=$2 and env=$3 and start_ms between $4 and $5) t
         cross join
         (select count(*) as logs,max(ts) as last_log from logs where org_id=$1 and service=$2 and $6=any(tags) and ts between $4 and $5) l`,
      [orgId, service, env, since, now, `env:${env}`],
    )
  ).rows[0];
  const traces = Number(r.traces),
    logs = Number(r.logs);
  return {
    supported: true,
    service,
    env,
    receiving: traces + logs > 0,
    traces,
    logs,
    lastTraceAt: r.last_trace ? Number(r.last_trace) : null,
    lastLogAt: r.last_log ? Number(r.last_log) : null,
    windowMs: 300000,
  };
}

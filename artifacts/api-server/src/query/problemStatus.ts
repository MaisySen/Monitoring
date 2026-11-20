// Human workflow status for problems (acknowledge / mute / resolve), kept strictly separate
// from measured state. A status record never edits monitor state or error-group counts; it
// only changes where a problem renders and which badge it carries. New measured activity
// after the status was set re-surfaces the problem: resolved -> back to active with
// "reopened", muted -> stays muted but is flagged with new activity inside the muted section.

export type WorkflowStatus = "acknowledged" | "muted" | "resolved";

export interface StatusRecord {
  status: WorkflowStatus;
  statusAt: number; // ms
  updatedBy: string;
}

export type ProblemSection = "active" | "muted" | "resolved";

export interface EffectiveProblem {
  section: ProblemSection;
  workflow: WorkflowStatus | null;
  statusAt: number | null;
  updatedBy: string | null;
  // resolved + new measured activity after statusAt -> true (renders in active, flagged).
  reopened: boolean;
  // muted + new measured activity after statusAt -> true (stays muted, flagged inside muted).
  newActivityAfterMute: boolean;
}

export function effectiveProblem(rec: StatusRecord | null | undefined, lastActivityMs: number | null): EffectiveProblem {
  if (!rec) return { section: "active", workflow: null, statusAt: null, updatedBy: null, reopened: false, newActivityAfterMute: false };
  const newer = lastActivityMs != null && lastActivityMs > rec.statusAt;
  if (rec.status === "resolved") {
    return { section: newer ? "active" : "resolved", workflow: "resolved", statusAt: rec.statusAt, updatedBy: rec.updatedBy, reopened: newer, newActivityAfterMute: false };
  }
  if (rec.status === "muted") {
    return { section: "muted", workflow: "muted", statusAt: rec.statusAt, updatedBy: rec.updatedBy, reopened: false, newActivityAfterMute: newer };
  }
  return { section: "active", workflow: "acknowledged", statusAt: rec.statusAt, updatedBy: rec.updatedBy, reopened: false, newActivityAfterMute: false };
}

export async function loadProblemStatuses(
  pool: { query: (q: string, v?: any[]) => Promise<{ rows: any[] }> },
  orgId: number,
): Promise<Map<string, StatusRecord>> {
  const hasTable = (await pool.query("select to_regclass('problem_status') is not null as e")).rows[0].e;
  const map = new Map<string, StatusRecord>();
  if (!hasTable) return map;
  const rows = (await pool.query("select kind, ref, status, status_at, updated_by from problem_status where org_id=$1", [orgId])).rows;
  for (const r of rows) {
    map.set(`${r.kind}:${r.ref}`, { status: r.status as WorkflowStatus, statusAt: Number(r.status_at), updatedBy: r.updated_by ?? "" });
  }
  return map;
}

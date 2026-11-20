// Service health derivation for /ui/now, extracted for unit testing. Rules (per product
// direction): health claims come only from observed data. Low traffic limits inference about
// overall health, but NEVER suppresses observed errors: error counts are shown alongside the
// uncertainty, never instead of it. Silence is "quiet" (idle vs down is unknowable), sparse
// traffic is "low" (not judged), and no-errors is "observed", never "healthy".

export interface ServiceHealthRow {
  service: string;
  last_bucket: number | string;
  ops5: number | string;
  err_ops5: number | string;
  ops_prev: number | string;
  err_ops_prev: number | string;
}

export interface ServiceHealth {
  service: string;
  state: "ok" | "degraded" | "low" | "quiet";
  note: string;
  ops5: number;
  errOps5: number;
  lastActiveAt: number;
}

export function computeServiceHealth(rows: ServiceHealthRow[], nowS: number): ServiceHealth[] {
  return rows.map((r) => {
    const ops5 = Number(r.ops5);
    const errOps5 = Number(r.err_ops5);
    const opsPrev = Number(r.ops_prev);
    const errOpsPrev = Number(r.err_ops_prev);
    const lastActiveS = Number(r.last_bucket) + 60;
    const quietMin = Math.floor((nowS - lastActiveS) / 60);
    let state: ServiceHealth["state"] = "ok";
    let note = `No errors observed in ${ops5} operations in the last 5 minutes`;
    if (quietMin >= 10) {
      state = "quiet";
      note = `No data for ${quietMin} minutes - the service may be idle or stopped; silence alone is not proof of failure`;
    } else if (ops5 < 20) {
      state = "low";
      note =
        errOps5 > 0
          ? `${errOps5} errors in ${ops5} operations in the last 5 minutes - too little traffic to judge overall health`
          : `Only ${ops5} operations in the last 5 minutes - too little traffic to judge health`;
    } else if (errOps5 > 0) {
      const rate = errOps5 / ops5;
      const baseRate = opsPrev >= 100 ? errOpsPrev / opsPrev : null;
      note = `${errOps5} errors in ${ops5} operations (${(rate * 100).toFixed(1)}%) in the last 5 minutes`;
      if (rate >= 0.02 && (baseRate === null ? errOps5 >= 5 : rate >= 3 * baseRate)) {
        state = "degraded";
        if (baseRate !== null) note += ` - previous-hour baseline ${(baseRate * 100).toFixed(2)}%`;
      }
    }
    return { service: r.service, state, note, ops5, errOps5, lastActiveAt: lastActiveS * 1000 };
  });
}

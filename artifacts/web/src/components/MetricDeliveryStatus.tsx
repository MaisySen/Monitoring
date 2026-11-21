import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
export function MetricDeliveryStatus() {
  const state = useQuery<any>({
    queryKey: ["experimental-metric-delivery"],
    queryFn: () => api("/ui/metric-delivery"),
    refetchInterval: (q) => (q.state.data?.enabled ? 5000 : false),
  });
  if (!state.data?.enabled)
    return state.isError ? (
      <div className="card p-4 text-warn">Metric delivery status unavailable. Receiving telemetry alone does not confirm metric storage.</div>
    ) : null;
  const receipts = state.data.receipts || [],
    diagnostics = state.data.diagnostics || [];
  return (
    <section className="card p-4 space-y-3 scroll-mt-28" aria-label="Experimental metric delivery">
      <div className="font-semibold">Experimental direct metric delivery, test only</div>
      <p className="text-xs text-ink-2">
        No durable app spool. Process exit, long offline periods or a full queue can lose unconfirmed measurements. Legacy agent delta delivery still has
        response-loss defects. Receiving data is not a stored receipt.
      </p>
      <button className="btn text-xs" onClick={() => state.refetch()}>
        Check stored receipts
      </button>
      {Number(state.data.losses?.count) > 0 && (
        <p className="text-sm text-warn">
          {state.data.losses.count} expired-unconfirmed delivery leases. Expiry range {new Date(Number(state.data.losses.firstUntil)).toLocaleString()} to{" "}
          {new Date(Number(state.data.losses.lastUntil)).toLocaleString()}. Old payloads and receipts are no longer retained. This includes server-refused and
          never-confirmed leases, not a count of lost measurements. It survives row removal but cannot count measurements that never reached the server.
        </p>
      )}
      {receipts.length === 0 && (
        <p className="text-sm">No confirmed metric receipts in the recovery window. This server cannot see measurements that never reached it.</p>
      )}
      {diagnostics.map((d: any) => {
        const stored = receipts.find((r: any) => r.id === d.id);
        const recover = !stored && d.state === "blocked" && d.retainedBytes > 0 && d.attempts < 3 && Number(d.until) > Date.now();
        return (
          <div className="border-t border-line pt-2 text-sm" key={d.id}>
            <div className="font-semibold">
              {stored
                ? "Stored, synchronous commit confirmed"
                : d.state === "stored"
                  ? "App reported success, receipt not currently confirmed"
                  : d.state === "blocked"
                    ? "Blocked, explicit app recovery needed"
                    : d.state === "expired-unconfirmed"
                      ? "Expired/unconfirmed, receipt check only"
                      : d.state === "lost"
                        ? "Lost from app memory, not recoverable"
                        : "Sending, not confirmed stored"}
            </div>
            <div className="text-xs text-ink-2">
              <span className="break-all">Delivery {d.id}</span>
              <br />
              Eligibility ends {new Date(Number(d.until)).toLocaleTimeString()}
            </div>
            <div className="text-xs text-ink-2">
              {stored
                ? `${stored.accepted} accepted points. Transaction synchronous_commit=${stored.synchronousCommit}.`
                : `App-reported attempts ${d.attempts}/3. Retained app bytes ${d.retainedBytes}. These bytes are not stored by this server.`}
            </div>
            {recover && (
              <button
                className="btn text-xs mt-2"
                onClick={() => navigator.clipboard.writeText(`monitoring.metricDelivery.recover(${JSON.stringify(d.localId)})`)}
              >
                Copy recovery call for the running app
              </button>
            )}
            {recover && (
              <p className="text-xs text-ink-2">
                Run the copied call in the same app only after fixing its API key, quota or connection. This page cannot replay app memory. No automatic retry
                or new identity is created here.
              </p>
            )}
          </div>
        );
      })}
      {receipts
        .filter((r: any) => !diagnostics.some((d: any) => d.id === r.id))
        .map((r: any) => (
          <div key={r.id} className="border-t border-line pt-2 text-sm">
            Stored: {r.accepted} points, synchronous_commit={r.synchronousCommit}.
            <div className="text-xs text-ink-2">
              <span className="break-all">Delivery {r.id}</span>
              <br />
              Eligibility ends {new Date(Number(r.until)).toLocaleTimeString()}
            </div>
          </div>
        ))}
      <p className="text-xs text-ink-2">
        Statuses and receipts are retained for a finite window. After it ends the outcome can be unknown. Never resend old delta values under a new identity.
      </p>
    </section>
  );
}

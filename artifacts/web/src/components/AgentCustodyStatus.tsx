import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
export function AgentCustodyStatus() {
  const q = useQuery<any>({
    queryKey: ["agent-custody-test"],
    queryFn: () => api("/ui/agent-custody"),
    refetchInterval: (x) => (x.state.data?.enabled ? 5000 : false),
  });
  if (!q.data?.enabled) return null;
  return (
    <section className="card p-4 space-y-3 scroll-mt-28" aria-label="Experimental agent custody">
      <h2 className="font-semibold">Agent custody experiment, not backend storage</h2>
      <p className="text-xs text-ink-2">
        Agent-reported durable local custody is separate from a backend receipt. This view cannot replay agent bytes. Reports may be stale or unavailable. The
        actual built-Agent product path is not yet verified.
      </p>
      {q.data.reports.length === 0 && <p className="text-sm">No authenticated agent journal reports. Absence of a report is not proof of storage or loss.</p>}
      {q.data.reports.map((r: any) => (
        <div className="border-t border-line pt-3 space-y-2" key={r.epoch}>
          <div className="text-xs text-ink-2 break-all">Journal {r.epoch}</div>
          <p className="text-xs">
            Reported {new Date(r.reportedAt).toLocaleString()}.{" "}
            {Date.now() - r.reportedAt > 15000
              ? "Stale snapshot. Contact the running agent before acting."
              : "Agent-reported snapshot, not a live custody guarantee."}
          </p>
          <p className="text-xs">
            Journal file {r.journalFileBytes.toLocaleString()} / {r.maxJournalFileBytes.toLocaleString()} bytes. Reusable pages may stay allocated after
            cleanup.
          </p>
          <p className="text-xs">
            Retired unconfirmed/refused leases: {r.counts.unconfirmed + r.counts.refused}. Stored receipts retired: {r.counts.stored}. These are journal lease
            counts, not lost measurements.
          </p>
          {r.entries.map((x: any) => (
            <div className="border-t border-line pt-2 text-sm" key={x.id}>
              <div className="font-semibold">
                {x.receipt
                  ? "Backend receipt confirmed"
                  : x.state === "stored"
                    ? "Agent reports backend success; current receipt unavailable"
                    : x.state === "issued"
                      ? "Input identity issued, no custody"
                      : x.state === "blocked"
                        ? "Agent custody blocked; recovery requires the running agent"
                        : x.state === "custody"
                          ? "Agent-reported custody, backend unconfirmed"
                          : "Expired or refused, do not create a new identity"}
              </div>
              <div className="text-xs text-ink-2 break-all">Input {x.id}</div>
              <p className="text-xs">
                {x.receipt
                  ? `${x.receipt.accepted} backend points confirmed.`
                  : `Agent-retained bytes ${x.retainedBytes}. Backend send attempts ${x.attempts}/3.`}
              </p>
            </div>
          ))}
        </div>
      ))}
      <p className="text-xs text-ink-2">
        Finite test-only journal and receipt windows. A lost or replaced journal cannot reaccept an old epoch. No default retries or automatic identity renewal.
      </p>
    </section>
  );
}

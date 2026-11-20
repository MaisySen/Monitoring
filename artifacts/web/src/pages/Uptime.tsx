import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Play, Globe } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { fmtAgo } from "@/lib/format";

// Availability is never claimed: the figures below are successful measured probes over the
// window covered by samples, not continuous availability.
type UptimeCheck = {
  id: number;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalS: number;
  timeoutMs: number;
  expectMin: number;
  expectMax: number;
  enabled: boolean;
  consecutiveFailures: number;
  lastOk: boolean | null;
  lastCheckedAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  createdAt: number;
  probesOkPct24h: number | null;
  samples24h: number;
  samplesOk24h: number;
  coverageSinceMs: number | null;
  recent: { ts: number; ok: boolean; status: number | null; durationMs: number | null; error: string | null }[];
};

type UptimeData = { supported: boolean; privateTargetsAllowed: boolean; checks: UptimeCheck[] };

// Uptime probing watches URLs from the outside. Every number here comes from measured
// probes: a check with no samples shows "no probes yet", never an assumed 100%.
export function Uptime() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["uptime"], queryFn: () => api<UptimeData>("/ui/uptime"), refetchInterval: 15_000 });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", intervalS: 60 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["uptime"] });

  const create = useMutation({
    mutationFn: () => api("/ui/uptime", { body: { name: form.name, url: form.url, intervalS: Number(form.intervalS) } }),
    onSuccess: () => {
      setAdding(false);
      setForm({ name: "", url: "", intervalS: 60 });
      invalidate();
    },
  });
  const run = useMutation({ mutationFn: (id: number) => api(`/ui/uptime/${id}/run`, { method: "POST" }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: (id: number) => api(`/ui/uptime/${id}`, { method: "DELETE" }), onSuccess: invalidate });

  const d = data.data;
  const checks = d?.checks ?? [];
  const err = (create.error as any)?.message ?? "";

  return (
    <div>
      <PageHeader title="Uptime" sub={d ? `${checks.length} check${checks.length === 1 ? "" : "s"}` : undefined}>
        <button className="btn-primary flex items-center gap-1.5" onClick={() => setAdding((v) => !v)}>
          <Plus size={14} /> New check
        </button>
      </PageHeader>
      <div className="p-6 space-y-4 max-w-4xl">
        {adding && (
          <div className="card p-4 space-y-3">
            <div className="section-title">New uptime check</div>
            <div className="text-[11px] text-ink-3">
              Monitoring probes this URL from this server on the interval you choose and counts it down after two
              consecutive failures. Only http(s) URLs on public addresses are accepted
              {d?.privateTargetsAllowed ? " (private targets currently allowed by the test-only server override)" : ""}.
            </div>
            <div className="flex gap-2 flex-wrap">
              <input
                className="input flex-1 min-w-40"
                placeholder="Name, e.g. Storefront"
                value={form.name}
                data-testid="uptime-name"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <input
                className="input flex-[2] min-w-60"
                placeholder="https://example.com/health"
                value={form.url}
                data-testid="uptime-url"
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              <select
                className="input w-36"
                value={form.intervalS}
                data-testid="uptime-interval"
                onChange={(e) => setForm({ ...form, intervalS: Number(e.target.value) })}
              >
                {[30, 60, 300, 900, 3600].map((s) => (
                  <option key={s} value={s}>
                    every {s >= 3600 ? "1h" : s >= 60 ? `${s / 60}m` : `${s}s`}
                  </option>
                ))}
              </select>
              <button
                className="btn-primary"
                data-testid="uptime-create"
                disabled={create.isPending || !form.name.trim() || !form.url.trim()}
                onClick={() => create.mutate()}
              >
                Create
              </button>
            </div>
            {err && <div className="text-xs text-bad">{err}</div>}
          </div>
        )}
        {d && !d.supported && (
          <div className="card p-4 text-xs text-ink-3">Uptime probing is not available on this install's storage backend.</div>
        )}
        {d && d.supported && checks.length === 0 && !adding && (
          <div className="card p-6 flex items-center gap-4">
            <Globe size={28} className="text-ink-3 shrink-0" />
            <div className="text-ink-2">
              No uptime checks yet. Add a URL and Monitoring will probe it on a schedule and raise a problem on the Now
              page after consecutive failures. An empty list means nothing is watched - not that everything is up.
            </div>
          </div>
        )}
        {checks.map((c) => (
          <div key={c.id} className="card" data-testid={`uptime-check-${c.id}`}>
            <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  c.lastOk == null ? "bg-nodata" : c.lastOk ? "bg-ok" : "bg-alert"
                }`}
              />
              <div className="min-w-0">
                <div className="font-medium truncate">{c.name}</div>
                <div className="text-xs text-ink-3 truncate">
                  {c.method} {c.url} · every {c.intervalS >= 60 ? `${c.intervalS / 60}m` : `${c.intervalS}s`} · expects{" "}
                  {c.expectMin}-{c.expectMax}
                </div>
              </div>
              <div className="ml-auto text-right shrink-0">
                <div className="text-sm">
                  {c.probesOkPct24h == null ? (
                    <span className="text-ink-3">no probes yet</span>
                  ) : (
                    <span className={c.probesOkPct24h >= 99 ? "text-ok" : c.probesOkPct24h >= 95 ? "text-warn" : "text-bad"}>
                      {c.samplesOk24h}/{c.samples24h} probes ok
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-3">
                  {c.samples24h > 0
                    ? `measured over ${Math.max(1, Math.round(((c.coverageSinceMs ? Date.now() - c.coverageSinceMs : 0) || 0) / 60000))}m (24h window) · `
                    : ""}
                  {c.lastCheckedAt ? `last ${fmtAgo(c.lastCheckedAt)}` : "never probed"}
                  {c.lastDurationMs != null ? ` · ${c.lastDurationMs}ms` : ""}
                </div>
              </div>
              <button
                className="btn p-1.5"
                title="Probe now"
                data-testid={`uptime-run-${c.id}`}
                disabled={run.isPending}
                onClick={() => run.mutate(c.id)}
              >
                <Play size={14} />
              </button>
              <button
                className="btn p-1.5 text-ink-3 hover:text-bad"
                title="Delete check"
                data-testid={`uptime-delete-${c.id}`}
                disabled={del.isPending}
                onClick={() => del.mutate(c.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {c.lastError && c.lastOk === false && (
              <div className="px-4 pb-2 text-[11px] text-bad">
                {c.consecutiveFailures} consecutive failure{c.consecutiveFailures === 1 ? "" : "s"}: {c.lastError}
              </div>
            )}
            {c.recent.length > 0 && (
              <div className="px-4 pb-3 flex items-end gap-[2px] h-8">
                {c.recent.map((r, i) => (
                  <div
                    key={i}
                    title={`${r.ok ? "up" : "down"}${r.status ? ` · ${r.status}` : ""}${r.error ? ` · ${r.error}` : ""} · ${fmtAgo(r.ts)}`}
                    className={`w-1.5 rounded-sm ${r.ok ? "bg-ok" : "bg-alert"}`}
                    style={{ height: `${Math.min(100, Math.max(20, ((r.durationMs ?? 0) / Math.max(1, c.timeoutMs)) * 100))}%` }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

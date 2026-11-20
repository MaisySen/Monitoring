import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch, useParams } from "wouter";
import { Search, Plus, Trash2, Copy, Eye, EyeOff, LayoutDashboard, Server, Bell, ScrollText, Activity, LineChart } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader, ICONS } from "@/components/Layout";
import { TimePicker } from "@/components/TimePicker";
import { StatusBadge, Empty } from "@/components/Panels";
import { MonitoringMark } from "@/components/Logo";
import { useTime } from "@/lib/time";
import { useAuthUser } from "@/lib/auth";
import { fmtAgo, fmtTime, fmtNum, fmtDuration } from "@/lib/format";

export function Events() {
  const { from, to, tick } = useTime();
  const [q, setQ] = useState("");
  const ev = useQuery({
    queryKey: ["events", q, from, to, tick],
    queryFn: () => api<{ events: any[] }>(`/ui/events?start=${from}&end=${to}&q=${encodeURIComponent(q)}`),
  });
  const color: Record<string, string> = { error: "#d33b4c", warning: "#e8a317", success: "#2ca05a", info: "#5b7be0" };
  return (
    <div>
      <PageHeader title="Events" icon={ICONS.events}>
        <TimePicker />
      </PageHeader>
      <div className="p-6">
        <div className="relative mb-3 max-w-xl">
          <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
          <input className="input w-full pl-8" placeholder="Search events" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {(ev.data?.events.length ?? 0) === 0 && !ev.isLoading ? (
          <Empty title="No events in this time range">Monitor state changes, agent events and events sent to the API appear here.</Empty>
        ) : (
          <div className="card divide-y divide-line">
            {ev.data?.events.map((e) => (
              <div key={e.id} className="flex gap-3 px-4 py-2.5">
                <span className="w-1 rounded shrink-0" style={{ background: color[e.alert_type] ?? "#5b7be0" }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate">{e.title}</span>
                    {e.monitor_id && (
                      <Link className="text-xs text-primary" href={`/monitors/${e.monitor_id}`}>
                        monitor →
                      </Link>
                    )}
                    <span className="ml-auto text-xs text-ink-3 whitespace-nowrap">{fmtTime(e.ts, true)}</span>
                  </div>
                  {e.text && <div className="text-xs text-ink-2 whitespace-pre-wrap mt-0.5 line-clamp-3">{e.text}</div>}
                  <div className="flex gap-1 mt-1">
                    <span className="chip">source:{e.source}</span>
                    {e.tags.slice(0, 6).map((t: string) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function KeyCell({ k }: { k: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="inline-flex items-center gap-2 mono text-xs">
      {show ? k : `${k.slice(0, 4)}••••••••••••${k.slice(-4)}`}
      <button onClick={() => setShow(!show)} className="text-ink-3">
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button onClick={() => navigator.clipboard.writeText(k)} className="text-ink-3" title="Copy">
        <Copy size={13} />
      </button>
    </span>
  );
}

/** Today's usage against the organization's ingestion limits; admins edit the limits. */
function UsagePanel({ isAdmin, setErr }: { isAdmin: boolean; setErr: (e: string | null) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["quotas"], queryFn: () => api<any>("/ui/org/quotas"), refetchInterval: 30_000 });
  const [form, setForm] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(form)) body[k] = v.trim() === "" ? null : Number(v);
      return api("/ui/org/quotas", { method: "PUT", body });
    },
    onError: (e: any) => setErr(e.message),
    onSuccess: () => {
      setErr(null);
      setForm({});
      qc.invalidateQueries({ queryKey: ["quotas"] });
    },
  });
  const quotas = q.data?.quotas ?? {};
  const usage = q.data?.usage ?? {};
  const fields: [string, string, number | null, number | undefined][] = [
    ["maxPointsPerDay", "Metric points per day", quotas.maxPointsPerDay, usage.points],
    ["maxLogsPerDay", "Logs per day", quotas.maxLogsPerDay, usage.logs],
    ["maxSpansPerDay", "Spans per day", quotas.maxSpansPerDay, usage.spans],
    ["maxSeries", "Active metric series", quotas.maxSeries, usage.series],
    ["maxIngestBytesPerMinute", "Ingest bytes per minute", quotas.maxIngestBytesPerMinute, usage.bytesThisMinute],
  ];
  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-xs text-ink-2">
        Usage today ({usage.day ?? "…"}) against this organization's limits. Empty means no limit. Data over a limit is
        refused and counted under dropped intake, so nothing is lost silently.
      </p>
      <table className="tbl card">
        <thead>
          <tr>
            <th>Limit</th>
            <th>Used today</th>
            <th>Limit</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(([key, label, limit, used]) => (
            <tr key={key}>
              <td>{label}</td>
              <td className={limit != null && (used ?? 0) >= limit ? "text-alert font-semibold" : ""}>{fmtNum(used ?? 0)}</td>
              <td>
                {isAdmin ? (
                  <input
                    className="input h-7 w-32 text-xs"
                    placeholder={limit == null ? "no limit" : String(limit)}
                    value={form[key] ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    data-testid={`quota-${key}`}
                  />
                ) : limit == null ? (
                  <span className="text-ink-3">no limit</span>
                ) : (
                  fmtNum(limit)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={save.isPending || !Object.keys(form).length} onClick={() => save.mutate()} data-testid="save-quotas">
            Save limits
          </button>
          {save.isSuccess && <span className="text-xs text-ink-2">Saved.</span>}
        </div>
      )}
      {q.data?.intake && Object.keys(q.data.intake).length > 0 && (
        <div>
          <div className="section-title mb-2">Intake since server start</div>
          <table className="tbl card">
            <thead>
              <tr>
                <th>Path</th>
                <th>Stored</th>
                <th>Dropped</th>
                <th>Last drop reason</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(q.data.intake).map(([path, s]: [string, any]) => (
                <tr key={path}>
                  <td className="mono text-xs">{path}</td>
                  <td>{fmtNum(s.stored)}</td>
                  <td className={s.dropped ? "text-alert" : ""}>{fmtNum(s.dropped)}</td>
                  <td className="text-ink-2 text-xs">{s.last_drop?.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Lists the signed-in user's organizations and offers create / join-with-invite. Switching lives in the sidebar. */
function OrganizationsPanel({
  createOrg,
  newOrgName,
  setNewOrgName,
  joinOrg,
  joinToken,
  setJoinToken,
  err,
}: {
  createOrg: any;
  newOrgName: string;
  setNewOrgName: (v: string) => void;
  joinOrg: any;
  joinToken: string;
  setJoinToken: (v: string) => void;
  err: string | null;
}) {
  const { user, orgs } = useAuthUser();
  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <div className="section-title mb-2">Your organizations</div>
        <table className="tbl card">
          <thead>
            <tr>
              <th>Name</th>
              <th>Your role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.orgId}>
                <td>{o.orgName}</td>
                <td className="capitalize">{o.role}</td>
                <td className="text-ink-2 text-xs">{o.orgId === user?.orgId ? "active" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-ink-3 mt-2">Switch between organizations from the menu under the Monitoring logo.</p>
      </div>
      <div>
        <div className="section-title mb-2">Create an organization</div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            createOrg.mutate();
          }}
        >
          <input
            className="input flex-1"
            placeholder="Organization name"
            maxLength={150}
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            data-testid="new-org-name"
          />
          <button className="btn-primary" disabled={createOrg.isPending || !newOrgName.trim()} data-testid="create-org">
            Create
          </button>
        </form>
      </div>
      <div>
        <div className="section-title mb-2">Join with an invite</div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            joinOrg.mutate();
          }}
        >
          <input
            className="input flex-1 mono"
            placeholder="Paste an invite link or token"
            value={joinToken}
            onChange={(e) => setJoinToken(e.target.value)}
            data-testid="join-token"
          />
          <button className="btn" disabled={joinOrg.isPending || !joinToken.trim()} data-testid="join-org">
            Join
          </button>
        </form>
      </div>
      {err && (
        <p role="alert" className="text-alert text-sm">
          {err}
        </p>
      )}
    </div>
  );
}

export function OrgSettings() {
  const qc = useQueryClient();
  const params = new URLSearchParams(useSearch());
  const [tab, setTab] = useState(params.get("tab") ?? "api-keys");
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<any>("/ui/org") });
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => api<{ channels: any[] }>("/ui/channels") });
  const inv = (fn: (v: any) => Promise<any>) => ({
    mutationFn: fn as (v: any) => Promise<any>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org"] });
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });
  const [keyName, setKeyName] = useState("");
  const [created, setCreated] = useState<{ kind: string; key: string } | null>(null);
  const addKey = useMutation(
    inv((kind: string) =>
      api("/ui/org/keys", { body: { kind, name: keyName.trim() || (kind === "app" ? "Application key" : "API key") } }).then((r) => {
        setKeyName("");
        setCreated({ kind: r.kind, key: r.key });
        return r;
      }),
    ),
  );
  const delKey = useMutation(inv((id: number) => api(`/ui/org/keys/${id}`, { method: "DELETE" })));
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const invite = useMutation({
    ...inv((e: string) => api("/ui/org/invites", { body: { email: e } })),
    onError: (e: any) => setErr(e.message),
    onSettled: () => setEmail(""),
  });
  const delInvite = useMutation(inv((id: number) => api(`/ui/org/invites/${id}`, { method: "DELETE" })));
  const setRole = useMutation({
    ...inv((v: { id: string; role: string }) => api(`/ui/org/members/${encodeURIComponent(v.id)}`, { method: "PATCH", body: { role: v.role } })),
    onError: (e: any) => setErr(e.message),
  });
  const removeMember = useMutation({
    ...inv((id: string) => api(`/ui/org/members/${encodeURIComponent(id)}`, { method: "DELETE" })),
    onError: (e: any) => setErr(e.message),
  });
  const [newOrgName, setNewOrgName] = useState("");
  const createOrg = useMutation({
    mutationFn: () => api("/ui/orgs", { body: { name: newOrgName.trim() } }),
    onError: (e: any) => setErr(e.message),
    onSuccess: () => {
      setNewOrgName("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });
  const [joinToken, setJoinToken] = useState("");
  const joinOrg = useMutation({
    mutationFn: () => {
      const m = joinToken.trim().match(/(?:\/invite\/)?([A-Za-z0-9]+)$/) ?? [];
      return api("/ui/org/invites/accept", { body: { token: m[1] ?? "" } });
    },
    onError: (e: any) => setErr(e.message),
    onSuccess: () => {
      setJoinToken("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });
  const [ch, setCh] = useState({ kind: "webhook", name: "", url: "" });
  const addCh = useMutation({
    ...inv(() => api("/ui/channels", { body: ch })),
    onError: (e: any) => setErr(e.message),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setErr(null);
      setCh({ kind: "webhook", name: "", url: "" });
    },
  });
  const delCh = useMutation(inv((id: number) => api(`/ui/channels/${id}`, { method: "DELETE" })));
  const isAdmin = org.data?.me?.role === "admin";
  const tabs = [
    ["api-keys", "API Keys"],
    ["app-keys", "Application Keys"],
    ["users", "Users"],
    ["organizations", "Organizations"],
    ["usage", "Usage & Limits"],
    ["integrations", "Webhooks & Slack"],
    ["sample", "Sample Data"],
  ];
  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Organization Settings" sub={org.data?.org?.name} />
      <div className="flex flex-1 min-h-0">
        <aside className="w-56 border-r border-line bg-panel py-3">
          {tabs.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`block w-full text-left px-4 py-1.5 text-[13px] ${tab === k ? "bg-brand-100 text-primary font-semibold" : "hover:bg-[#eef2fc]"}`}
            >
              {l}
            </button>
          ))}
        </aside>
        <div className="flex-1 overflow-auto p-6">
          {err && (
            <div className="card bg-red-50 border-alert/30 text-alert p-2 text-xs mb-3" onClick={() => setErr(null)}>
              {err}
            </div>
          )}
          {(tab === "api-keys" || tab === "app-keys") &&
            (() => {
              const kind = tab === "api-keys" ? "api" : "app";
              const keys = (org.data?.keys ?? []).filter((k: any) => k.kind === kind);
              return (
                <div>
                  <div className="flex items-center mb-3">
                    <p className="text-ink-2 max-w-2xl">
                      {kind === "api"
                        ? "API keys identify your organization when the agent, tracers and the HTTP intake send data to Monitoring."
                        : "Application keys, used together with an API key, give scripts access to the Monitoring API (dashboards, monitors, queries)."}
                    </p>
                    {isAdmin && (
                      <>
                        <input
                          className="input ml-auto w-56"
                          placeholder="Key name (optional)"
                          aria-label="New key name"
                          value={keyName}
                          onChange={(e) => setKeyName(e.target.value)}
                          maxLength={100}
                        />
                        <button className="btn-primary ml-2" onClick={() => addKey.mutate(kind)} data-testid={`new-${kind}-key`}>
                          <Plus size={14} /> New Key
                        </button>
                      </>
                    )}
                  </div>
                  {!isAdmin && <p className="text-xs text-ink-3 mb-3">Only admins can create, view or revoke keys.</p>}
                  {created?.kind === kind && (
                    <div className="card bg-panel p-3 mb-3 text-xs" data-testid="new-key-banner">
                      <div className="font-semibold mb-1">
                        {kind === "app" ? "Copy your new application key now. It will not be shown again." : "New API key created."}
                      </div>
                      <KeyCell k={created.key} />
                    </div>
                  )}
                  <table className="tbl card">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Key</th>
                        <th>Created</th>
                        <th>Last used</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k: any) => (
                        <tr key={k.id}>
                          <td>{k.name}</td>
                          <td><span className="mono text-xs text-ink-3">{k.hint}</span></td>
                          <td className="text-ink-2">{fmtAgo(new Date(k.created_at).getTime())}</td>
                          <td className="text-ink-2">{k.last_used_at ? fmtAgo(new Date(k.last_used_at).getTime()) : "never"}</td>
                          <td className="text-right">
                            {isAdmin && (
                              <button
                                className="text-ink-3 hover:text-alert"
                                aria-label="Revoke key"
                                onClick={() => confirm("Revoke this key? Anything using it will stop working.") && delKey.mutate(k.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          {tab === "users" && (
            <div className="space-y-6">
              {isAdmin && (
                <div className="card p-4">
                  <div className="section-title mb-1">Invite a tester</div>
                  <p className="text-xs text-ink-2 mb-2">
                    Share an invite link so a new member can create their password and join this organization. Links expire after 30 days and can only be used
                    once.
                  </p>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      invite.mutate(email);
                    }}
                  >
                    <input
                      className="input w-80"
                      type="email"
                      placeholder="name@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      data-testid="invite-email"
                    />
                    <button className="btn-primary" disabled={!email}>
                      Send invite
                    </button>
                  </form>
                </div>
              )}
              <div>
                <div className="section-title mb-2">Users ({org.data?.members?.length ?? 0})</div>
                <table className="tbl card">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Joined</th>
                      {isAdmin && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(org.data?.members ?? []).map((m: any) => (
                      <tr key={m.id}>
                        <td>{m.name || "—"}</td>
                        <td>{m.email}</td>
                        <td className="capitalize">
                          {isAdmin ? (
                            <select
                              className="input h-7 text-xs"
                              value={m.role}
                              disabled={setRole.isPending}
                              onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value })}
                              data-testid={`role-${m.email}`}
                            >
                              <option value="member">member</option>
                              <option value="admin">admin</option>
                            </select>
                          ) : (
                            m.role
                          )}
                        </td>
                        <td className="text-ink-2">{fmtAgo(new Date(m.created_at).getTime())}</td>
                        {isAdmin && (
                          <td>
                            <button
                              className="text-alert text-xs"
                              disabled={removeMember.isPending}
                              onClick={() => {
                                if (window.confirm(`Remove ${m.email} from this organization?`)) removeMember.mutate(m.id);
                              }}
                              data-testid={`remove-${m.email}`}
                            >
                              Remove
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(org.data?.invites ?? []).length > 0 && (
                <div>
                  <div className="section-title mb-2">Pending invites</div>
                  <table className="tbl card">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Invite link</th>
                        <th>Sent</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.data.invites.map((i: any) => (
                        <tr key={i.id}>
                          <td>{i.email}</td>
                          <td>
                            {i.link && (
                              <button
                                className="text-primary text-xs inline-flex items-center gap-1"
                                onClick={() => navigator.clipboard.writeText(new URL(i.link, location.origin).href)}
                              >
                                <Copy size={12} /> Copy link
                              </button>
                            )}
                          </td>
                          <td className="text-ink-2">{fmtAgo(new Date(i.created_at).getTime())}</td>
                          <td className="text-right">
                            {isAdmin && (
                              <button className="text-ink-3 hover:text-alert" onClick={() => delInvite.mutate(i.id)}>
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === "organizations" && (
            <OrganizationsPanel
              createOrg={createOrg}
              newOrgName={newOrgName}
              setNewOrgName={setNewOrgName}
              joinOrg={joinOrg}
              joinToken={joinToken}
              setJoinToken={setJoinToken}
              err={err}
            />
          )}
          {tab === "usage" && <UsagePanel isAdmin={isAdmin} setErr={setErr} />}
          {tab === "sample" && (
            <div className="card p-5 max-w-2xl space-y-3">
              <div className="section-title">Sample data</div>
              <p className="text-ink-2">
                Simulates four hosts and three services (storefront, checkout-api, payments) sending metrics, logs and traces through the same intake the agent
                uses, for two hours, with 30 minutes of history. Useful for exploring Monitoring before installing an agent. Sample data is tagged{" "}
                <span className="mono">env:sample</span>.
              </p>
              <SampleDataButton />
            </div>
          )}
          {tab === "integrations" && (
            <div className="space-y-4">
              <p className="text-ink-2 max-w-2xl">
                Monitors notify a channel when you mention it in the monitor message, e.g. <span className="mono">@webhook-oncall</span> or{" "}
                <span className="mono">@slack-alerts</span>. Slack channels take a Slack incoming-webhook URL.
              </p>
              {!isAdmin && <p className="text-xs text-ink-3">Only admins can add or remove channels.</p>}
              <form
                hidden={!isAdmin}
                className="card p-4 flex flex-wrap gap-2 items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  addCh.mutate(undefined);
                }}
              >
                <label className="text-xs">
                  <div className="label mb-1">Type</div>
                  <select className="input" value={ch.kind} onChange={(e) => setCh({ ...ch, kind: e.target.value })}>
                    <option value="webhook">Webhook</option>
                    <option value="slack">Slack</option>
                  </select>
                </label>
                <label className="text-xs">
                  <div className="label mb-1">Name</div>
                  <input
                    className="input w-48"
                    value={ch.name}
                    onChange={(e) => setCh({ ...ch, name: e.target.value })}
                    placeholder="oncall"
                    data-testid="channel-name"
                  />
                </label>
                <label className="text-xs flex-1">
                  <div className="label mb-1">URL</div>
                  <input
                    className="input w-full"
                    value={ch.url}
                    onChange={(e) => setCh({ ...ch, url: e.target.value })}
                    placeholder="https://hooks.example.com/..."
                    data-testid="channel-url"
                  />
                </label>
                <button className="btn-primary" disabled={!ch.name || !ch.url}>
                  Add channel
                </button>
              </form>
              <table className="tbl card">
                <thead>
                  <tr>
                    <th>Handle</th>
                    <th>Type</th>
                    <th>URL</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(channels.data?.channels ?? []).map((c) => (
                    <tr key={c.id}>
                      <td className="mono text-xs">
                        @{c.kind}-{c.name}
                      </td>
                      <td className="capitalize">{c.kind}</td>
                      <td className="mono text-xs truncate max-w-[420px]">{c.config.url}</td>
                      <td className="text-right">
                        {isAdmin && (
                          <button className="text-ink-3 hover:text-alert" aria-label="Delete channel" onClick={() => delCh.mutate(c.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentSetup() {
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<any>("/ui/org") });
  const qc = useQueryClient();
  const isAdmin = org.data?.me?.role === "admin";
  // API keys are only ever shown once, at creation. The install command embeds a freshly
  // created key on demand; it is never read back from the server. To rotate, revoke the
  // key in Organization Settings and create a new one here.
  const [newKey, setNewKey] = useState<string | null>(null);
  const createKey = useMutation({
    mutationFn: () => api<any>("/ui/org/keys", { body: { kind: "api", name: "Agent install key" } }),
    onSuccess: (r) => {
      setNewKey(r.key);
      qc.invalidateQueries({ queryKey: ["org"] });
    },
  });
  const key = newKey ?? "PASTE-YOUR-API-KEY";
  const url = org.data?.public_url ?? location.origin;
  const [tab, setTab] = useState("linux");
  const yaml = `api_key: ${key}
url: ${url}
env: prod
host_metrics:
  enabled: true
apm:
  otlp: true
  datadog_compat: true
dogstatsd:
  enabled: true
logs:
  - path: /var/log/myapp/*.log
    service: myapp`;
  const docker = `docker run -d --name monitoring-agent --network host \
  -v /proc:/hostfs/proc:ro -v /var/log:/var/log:ro \
  -v /etc/monitoring:/etc/monitoring \
  -e MONITORING_API_KEY=${key} \
  debian:stable-slim sh -c "apt-get update -qq && apt-get install -yqq curl >/dev/null && curl -fsSL ${url}/install.sh | sh && /opt/monitoring-agent/bin/monitoring-agent run -c /etc/monitoring/monitoring.yaml"`;
  const code = (s: string) => (
    <div className="relative">
      <pre className="mono text-xs bg-[#23222c] text-white rounded p-4 overflow-auto">{s}</pre>
      <button className="absolute top-2 right-2 text-white/60 hover:text-white" onClick={() => navigator.clipboard.writeText(s)}>
        <Copy size={14} />
      </button>
    </div>
  );
  return (
    <div>
      <PageHeader title="Install the Monitoring Agent" />
      <div className="p-6 max-w-4xl space-y-5">
        <p className="text-ink-2">
          The Monitoring Agent is built on the OpenTelemetry Collector. It reports host metrics, tails log files, relays traces, metrics and logs from your apps,
          and accepts compatible tracer and StatsD traffic for easy migration. See the{" "}
          <a className="text-primary" href="/docs/agent">
            agent guide
          </a>{" "}
          and the{" "}
          <a className="text-primary" href="/docs/nodejs">
            Node.js
          </a>{" "}
          /{" "}
          <a className="text-primary" href="/docs/python">
            Python
          </a>{" "}
          libraries.
        </p>
        {newKey ? (
          <div className="card bg-panel p-3 text-xs" data-testid="install-key-banner">
            <div className="font-semibold mb-1">Install key created. It is embedded in the commands below and will not be shown again.</div>
            <div className="text-ink-2">To rotate it later, revoke "Agent install key" in Organization Settings and create a new one.</div>
          </div>
        ) : (
          <div className="card bg-panel p-3 text-xs flex items-center gap-3">
            <span className="text-ink-2">
              The commands below need an API key.{" "}
              {isAdmin ? "Create one now - it is shown once, embedded in the commands." : "Ask an admin to create one on this page, then paste it in."}
            </span>
            {isAdmin && (
              <button className="btn-primary shrink-0" disabled={createKey.isPending} onClick={() => createKey.mutate()} data-testid="create-install-key">
                <Plus size={14} /> Create install key
              </button>
            )}
          </div>
        )}
        <div className="flex gap-1">
          {[
            ["linux", "Linux (one line)"],
            ["config", "Config file"],
            ["docker", "Docker"],
            ["libs", "Libraries"],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 h-8 rounded text-[13px] ${tab === k ? "bg-primary text-white" : "bg-panel hover:bg-[#eef2fc]"}`}
            >
              {l}
            </button>
          ))}
        </div>
        {tab === "linux" && (
          <>
            {code(`curl -fsSL ${url}/install.sh | MONITORING_API_KEY=${key} sh`)}
            <p className="text-xs text-ink-2">
              Installs <span className="mono">/opt/monitoring-agent/bin/monitoring-agent</span>, writes <span className="mono">/etc/monitoring/monitoring.yaml</span> and
              starts the service on systemd hosts. Your host appears in Infrastructure within a minute.
            </p>
          </>
        )}
        {tab === "config" && (
          <>
            {code(yaml)}
            <p className="text-xs text-ink-2">
              Edit <span className="mono">/etc/monitoring/monitoring.yaml</span> and restart the agent.{" "}
              <span className="mono">monitoring-agent config -c /etc/monitoring/monitoring.yaml</span> prints the generated OpenTelemetry Collector configuration.
            </p>
          </>
        )}
        {tab === "docker" && code(docker)}
        {tab === "libs" &&
          code(`# Node.js
npm install ${url}/downloads/monitoring-trace-0.1.0.tgz
MONITORING_SERVICE=my-app MONITORING_ENV=prod node -r @monitoring/trace/init app.js

# Python
pip install "monitoring-trace[instrumentation] @ ${url}/downloads/monitoring_trace-0.1.0-py3-none-any.whl"
MONITORING_SERVICE=my-app MONITORING_ENV=prod monitoring-run python app.py`)}
      </div>
    </div>
  );
}

export function SampleDataButton() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["sample"], queryFn: () => api<{ running: boolean }>("/ui/org/sample-data") });
  const m = useMutation({
    mutationFn: (stop: boolean) => api<{ running: boolean }>("/ui/org/sample-data", { body: stop ? { stop: true } : { minutes: 120 } }),
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });
  const running = st.data?.running;
  return (
    <button className="btn" disabled={m.isPending} onClick={() => m.mutate(!!running)} data-testid="sample-data">
      {m.isPending ? "Loading sample data…" : running ? "Stop sample data" : "Load sample data"}
    </button>
  );
}

type NowData = {
  now: number;
  receiving: boolean;
  lastDataAt: number | null;
  totals: { spans: number; logs: number };
  services: { service: string; state: "ok" | "degraded" | "low" | "quiet"; note: string; ops5: number; errOps5: number; lastActiveAt: number }[];
  problems: { monitorId: number; name: string; state: string; service: string | null; auto: boolean; since: number | null; query: string }[];
};

const healthChip: Record<string, { dot: string; label: string }> = {
  ok: { dot: "#2ca05a", label: "No errors observed" },
  degraded: { dot: "#d33b4c", label: "Degraded" },
  low: { dot: "#e8a317", label: "Low traffic" },
  quiet: { dot: "#8a94a6", label: "No recent data" },
};

export function Home() {
  const now = useQuery({ queryKey: ["now"], queryFn: () => api<NowData>("/ui/now"), refetchInterval: 30_000 });
  const d = now.data;
  const noData = d && d.totals.spans === 0;
  return (
    <div>
      <PageHeader title="Now" sub={d?.receiving ? "Receiving data" : d ? "Not receiving data" : undefined} />
      <div className="p-6 space-y-4 max-w-4xl">
        {noData && (
          <div className="card p-6 flex items-center gap-5 bg-[#eef2fc] border-brand-100">
            <MonitoringMark size={48} />
            <div className="flex-1">
              <div className="section-title">Connect your app</div>
              <div className="text-ink-2">
                Add Monitoring to your code (Node.js or Python). This page fills in by itself the moment the first data arrives - nothing to
                configure, no dashboards to build.
              </div>
            </div>
            <SampleDataButton />
            <Link href="/onboarding" className="btn-primary">
              Connect your app
            </Link>
          </div>
        )}
        <div className="card">
          <div className="px-4 py-2 border-b border-line font-semibold flex">
            Problems
            <Link href="/monitors/manage" className="ml-auto text-xs text-primary font-normal">
              All monitors →
            </Link>
          </div>
          {!d ? null : d.problems.length === 0 ? (
            <div className="px-4 py-4 text-ink-3 text-xs">
              {d.totals.spans === 0
                ? "Nothing to watch yet - problems appear here once your app sends data."
                : "No monitor is firing right now. Default monitors watch every new service for sustained errors and silence; their thresholds are starting points you can tune."}
            </div>
          ) : (
            d.problems.map((p) => (
              <Link key={p.monitorId} href={`/monitors/${p.monitorId}`} className="flex items-center gap-2 px-4 py-2.5 border-b border-line hover:bg-[#eef2fc]">
                <StatusBadge state={p.state} />
                <span className="truncate font-medium">{p.name}</span>
                {p.service && (
                  <Link href={`/apm/services/${encodeURIComponent(p.service)}`} className="text-xs text-primary">
                    {p.service}
                  </Link>
                )}
                {p.service && p.name.includes("Errors in") && (
                  <Link href={`/errors?service=${encodeURIComponent(p.service)}`} className="text-xs text-primary">
                    Error groups →
                  </Link>
                )}
                {p.since && <span className="ml-auto text-xs text-ink-3">{fmtAgo(p.since)}</span>}
              </Link>
            ))
          )}
        </div>
        <div className="card">
          <div className="px-4 py-2 border-b border-line font-semibold flex">
            Services
            <Link href="/apm/services" className="ml-auto text-xs text-primary font-normal">
              Service Catalog →
            </Link>
          </div>
          {!d ? null : d.services.length === 0 ? (
            <div className="px-4 py-4 text-ink-3 text-xs">No services have sent data in the last 24 hours.</div>
          ) : (
            d.services.map((s) => (
              <Link
                key={s.service}
                href={`/apm/services/${encodeURIComponent(s.service)}`}
                className="flex items-center gap-3 px-4 py-2.5 border-b border-line hover:bg-[#eef2fc]"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: healthChip[s.state]?.dot }} title={healthChip[s.state]?.label} />
                <span className="font-medium text-primary shrink-0">{s.service}</span>
                <span className="text-xs text-ink-2 truncate">{s.note}</span>
              </Link>
            ))
          )}
          {d && d.services.length > 0 && (
            <div className="px-4 py-2 text-[11px] text-ink-3">
              Health is computed from the last 5 minutes of traffic. No errors observed is not proof a service is healthy; silence and low
              traffic are shown, never hidden.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


const STACKS = [
  { id: "node", label: "Node.js" },
  { id: "python", label: "Python" },
  { id: "otlp", label: "Any OpenTelemetry" },
];

export function Onboarding() {
  const org = useQuery({ queryKey: ["org"], queryFn: () => api<any>("/ui/org") });
  const now = useQuery({ queryKey: ["onboard-now"], queryFn: () => api<NowData>("/ui/now"), refetchInterval: 3_000 });
  const [stack, setStack] = useState("node");
  const URL = org.data?.public_url ?? location.origin;
  const KEY = "PASTE-YOUR-API-KEY"; // placeholder: the real key stays in Organization Settings, never in this page
  const receiving = !!now.data?.receiving;
  const services = now.data?.services ?? [];
  const snippet: Record<string, string> = {
    node: `npm install ${URL}/downloads/monitoring-trace-0.1.0.tgz

MONITORING_URL=${URL} \
MONITORING_API_KEY=${KEY} \
MONITORING_SERVICE=my-app MONITORING_ENV=prod \
node -r @monitoring/trace/init app.js`,
    python: `pip install "monitoring-trace[instrumentation] @ ${URL}/downloads/monitoring_trace-0.1.0-py3-none-any.whl"

MONITORING_URL=${URL} \
MONITORING_API_KEY=${KEY} \
MONITORING_SERVICE=my-app MONITORING_ENV=prod \
python app.py`,
    otlp: `export OTEL_EXPORTER_OTLP_ENDPOINT=${URL}/otlp
export OTEL_EXPORTER_OTLP_HEADERS=DC-API-KEY=${KEY}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# point your existing OpenTelemetry SDK or Collector at these`,
  };
  return (
    <div>
      <PageHeader title="Connect your app" sub="First data usually arrives within a minute of starting your app" />
      <div className="p-6 space-y-4 max-w-3xl">
        <div className={"card p-4 flex items-center gap-3 " + (receiving ? "border-ok" : "")}>
          <span className={"w-2.5 h-2.5 rounded-full shrink-0 " + (receiving ? "bg-ok" : "bg-warn animate-pulse")} />
          <div className="flex-1">
            {receiving ? (
              <>
                <div className="font-semibold">Receiving data{services.length ? ` from ${services.map((s) => s.service).join(", ")}` : ""}</div>
                <div className="text-xs text-ink-2">Default monitors now watch each new service for sustained errors and silence. Their thresholds are starting points, not tuned detection.</div>
              </>
            ) : (
              <>
                <div className="font-semibold">Waiting for data…</div>
                <div className="text-xs text-ink-2">
                  This checks every few seconds. If nothing arrives after a couple of minutes, check that MONITORING_URL and the API key
                  reached your app - Monitoring cannot see why a client is not connecting.
                </div>
              </>
            )}
          </div>
          {receiving && (
            <Link href="/" className="btn-primary">
              Open your Now page →
            </Link>
          )}
        </div>
        <div className="card p-4">
          <div className="section-title mb-1">1. Create an API key</div>
          <div className="text-[13px] text-ink-2">
            It identifies your organization. Create or copy it under{" "}
            <Link className="text-primary" href="/organization-settings">
              Organization Settings → API Keys
            </Link>
            . Keep it secret: snippets below use a placeholder on purpose.
          </div>
        </div>
        <div className="card p-4">
          <div className="section-title mb-2">2. Add Monitoring to your app</div>
          <div className="flex gap-2 mb-3">
            {STACKS.map((s) => (
              <button key={s.id} className={"btn " + (stack === s.id ? "btn-primary" : "")} onClick={() => setStack(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <pre className="mono text-[12px] bg-panel border border-line rounded p-3 overflow-x-auto whitespace-pre">{snippet[stack]}</pre>
          <div className="text-[12px] text-ink-3 mt-2">
            Full guides, including running through the Monitoring Agent: <Link className="text-primary" href="/docs/getting-started">Docs → Getting started</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ErrorGroupsData {
  supported: boolean;
  groups: {
    fingerprint: string;
    service: string;
    envs: string[];
    errorType: string;
    messageExample: string;
    firstSeen: number;
    lastSeen: number;
    count: number;
  }[];
}

export function Errors() {
  const search = useSearch();
  const svcFilter = new URLSearchParams(search).get("service") ?? "";
  const d = useQuery({
    queryKey: ["error-groups", svcFilter],
    queryFn: () => api<ErrorGroupsData>(`/ui/errors${svcFilter ? `?service=${encodeURIComponent(svcFilter)}` : ""}`),
    refetchInterval: 30_000,
  });
  const groups = d.data?.groups ?? [];
  return (
    <div>
      <PageHeader title="Errors" sub="Recurring exceptions grouped by type and message shape" />
      <div className="p-6 space-y-4 max-w-5xl">
        {svcFilter && (
          <div className="text-[13px] text-ink-2">
            Filtered to <span className="font-semibold">{svcFilter}</span> · <Link className="text-primary" href="/errors">show all services</Link>
          </div>
        )}
        <div className="card">
          {!d.data ? null : !d.data.supported ? (
            <div className="px-4 py-4 text-ink-3 text-xs">Error grouping is not available on this storage backend yet.</div>
          ) : groups.length === 0 ? (
            <div className="px-4 py-4 text-ink-3 text-xs">
              No error groups recorded yet. Groups form when spans arrive with error details; an empty list here only means none have been
              observed, not that none occurred.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.fingerprint} className="px-4 py-3 border-b border-line">
                <div className="flex items-center gap-2 flex-wrap">
                  {g.errorType ? (
                    <span className="mono text-[11px] px-1.5 py-0.5 rounded bg-[#fde8e8] text-bad">{g.errorType}</span>
                  ) : (
                    <span className="mono text-[11px] px-1.5 py-0.5 rounded bg-panel text-ink-2">error</span>
                  )}
                  <span className="font-medium text-[13px]">{g.service}</span>
                  <span className="text-xs text-ink-3">{g.envs.length ? g.envs.join(", ") : "no env tag"}</span>
                  <span className="ml-auto text-xs text-ink-3">
                    {fmtNum(g.count)}× · first {fmtAgo(g.firstSeen)} · last {fmtAgo(g.lastSeen)}
                  </span>
                </div>
                <div className="mono text-[12px] text-ink-2 mt-1 break-all">{g.messageExample}</div>
                <div className="text-xs mt-1">
                  <Link className="text-primary" href={`/errors/${g.fingerprint}`}>
                    Matching error traces →
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="text-[11px] text-ink-3">
          Grouped at intake by error type and message shape (numbers and ids are normalized). Environment does not split a group, so one
          group can span environments; every observed environment is listed. Counts come from stored error spans; re-delivered data is not
          double-counted.
        </div>
      </div>
    </div>
  );
}


interface ErrorGroupDetailData {
  group: {
    fingerprint: string;
    service: string;
    envs: string[];
    errorType: string;
    messageExample: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
  };
  spans: { traceId: string; spanId: string; startMs: number; durationNs: number; errorType: string; errorMessage: string }[];
  scanned: number;
  scanTruncated: boolean;
  versionCorrelation: {
    rows: { env: string; version: string; errors: number; operations: number }[];
    coverage: {
      matchedTotal: number;
      groupCount: number;
      scanned: number;
      scanTruncated: boolean;
      windowDays: number;
      denominator: "entry_spans";
    };
  };
}

export function ErrorGroupDetail() {
  const { fingerprint } = useParams<{ fingerprint: string }>();
  const d = useQuery({ queryKey: ["error-group", fingerprint], queryFn: () => api<ErrorGroupDetailData>(`/ui/errors/${fingerprint}/spans`) });
  const g = d.data?.group;
  return (
    <div>
      <PageHeader title={g ? `${g.errorType || "Error"} in ${g.service}` : "Error group"} sub={g ? g.messageExample : ""} />
      <div className="p-6 space-y-4 max-w-4xl">
        <div className="text-[13px] text-ink-2">
          <Link className="text-primary" href="/errors">← All error groups</Link>
        </div>
        {g && (
          <div className="card p-4 text-[13px] space-y-1">
            <div>
              <span className="font-semibold">{fmtNum(g.count)} occurrences</span> · first {fmtAgo(g.firstSeen)} · last {fmtAgo(g.lastSeen)}
            </div>
            <div className="text-ink-2">Environments observed in this group: {g.envs.length ? g.envs.join(", ") : "no env tag"}</div>
          </div>
        )}
        {d.data && d.data.versionCorrelation.rows.length > 0 && (
          <div className="card p-4">
            <div className="section-title mb-2">Version correlation (hypothesis only)</div>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-ink-3 border-b border-line">
                  <th className="py-1 font-medium">environment</th>
                  <th className="py-1 font-medium">version</th>
                  <th className="py-1 font-medium">errors in this group</th>
                  <th className="py-1 font-medium">operations (entry spans)</th>
                </tr>
              </thead>
              <tbody>
                {d.data.versionCorrelation.rows.map((r) => (
                  <tr key={r.env + "|" + r.version} className="border-b border-line">
                    <td className="py-1">{r.env}</td>
                    <td className="py-1 mono">{r.version}</td>
                    <td className="py-1">{r.errors}</td>
                    <td className="py-1">{r.operations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] text-ink-3 mt-2 space-y-1">
              <div>
                Errors counted over {fmtNum(d.data.versionCorrelation.coverage.matchedTotal)} of {fmtNum(d.data.versionCorrelation.coverage.groupCount)} recorded
                occurrences, from a scan of {fmtNum(d.data.versionCorrelation.coverage.scanned)} recent error spans
                {d.data.versionCorrelation.coverage.scanTruncated ? " - scan limit reached, older occurrences are not covered" : ""}. Operations are counted over all
                entry spans in the same {d.data.versionCorrelation.coverage.windowDays}-day window.
              </div>
              <div>
                Entry spans approximate operations, not requests, and instrumentation depth can differ between versions. Rows are split by
                environment so a staging-only version does not read as a production regression. A concentration is a lead to investigate,
                not proof a version caused the errors.
              </div>
            </div>
          </div>
        )}
        <div className="card">
          <div className="px-4 py-2 border-b border-line font-semibold">Matching error traces</div>
          {!d.data ? null : d.data.spans.length === 0 ? (
            <div className="px-4 py-4 text-ink-3 text-xs">
              No matching spans found in the recent scan window (last 7 days). Older occurrences may have aged out of storage.
            </div>
          ) : (
            d.data.spans.map((s) => (
              <Link key={s.traceId + s.spanId} href={`/apm/trace/${s.traceId}`} className="flex items-center gap-3 px-4 py-2 border-b border-line hover:bg-[#eef2fc]">
                <span className="mono text-[12px] text-primary">{s.traceId.slice(0, 16)}…</span>
                <span className="mono text-[12px] text-ink-2 truncate flex-1">{s.errorMessage || s.errorType || "error"}</span>
                <span className="text-xs text-ink-3 shrink-0">{fmtAgo(s.startMs)}</span>
              </Link>
            ))
          )}
          {d.data && (
            <div className="px-4 py-2 text-[11px] text-ink-3">
              Matched by recomputing each span's fingerprint from its stored error details. Scanned {fmtNum(d.data.scanned)} recent error
              spans{d.data.scanTruncated ? " (scan limit reached - older matches may not be listed)" : ""}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Login({ restricted, email }: { restricted?: boolean; email?: string | null }) {
  const { logout, data } = useAuthUser();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const token = window.location.pathname.startsWith("/invite/") ? window.location.pathname.split("/")[2] : "";
  const invite = useQuery({
    queryKey: ["invite", token],
    enabled: !!token,
    queryFn: () => api<{ email: string; role: string }>(`/auth/invites/${encodeURIComponent(token)}`),
    retry: false,
  });
  const setup = !!data?.setupRequired && !token;
  const oidc = useQuery({
    queryKey: ["oidc-enabled"],
    queryFn: () => api<{ enabled: boolean }>("/auth/oidc/enabled"),
    staleTime: 60_000,
  });
  const submit = useMutation({
    mutationFn: () =>
      api(token ? `/auth/invites/${encodeURIComponent(token)}` : setup ? "/auth/setup" : "/auth/login", {
        body: { email: invite.data?.email ?? address, password, orgName, ...(setup && data?.setupTokenRequired ? { setupToken } : {}) },
      }),
    onSuccess: () => {
      window.location.href = "/";
    },
  });
  // Signed-in users joining another organization through an invite link.
  const accept = useMutation({
    mutationFn: () => api("/ui/org/invites/accept", { body: { token } }),
    onSuccess: () => {
      window.location.href = "/";
    },
  });
  return (
    <div className="min-h-full flex items-center justify-center bg-brand-900 py-8">
      <div className="bg-white rounded-lg shadow-2xl p-8 w-[400px] text-center">
        <div className="flex justify-center mb-3">
          <MonitoringMark size={56} />
        </div>
        <h1 className="text-[22px] font-bold mb-1">Monitoring</h1>
        <p className="text-ink-2 mb-6">Metrics, logs, traces, dashboards and alerts in one place.</p>
        {setup && <h2 className="font-semibold text-base mb-4">Create your admin account + organization</h2>}
        {token && <h2 className="font-semibold text-base mb-4">Join your organization</h2>}
        {invite.isError && (
          <p role="alert" className="text-alert mb-4 text-sm">
            {invite.error.message}
          </p>
        )}
        {token && data?.signedIn ? (
          invite.data && (
            <>
              <p className="text-sm text-ink-2 mb-4 text-left">
                Signed in as <b>{data.email}</b>.
              </p>
              {invite.data.email.toLowerCase() === (data.email ?? "").toLowerCase() ? (
                <button className="btn-primary w-full justify-center h-10" disabled={accept.isPending} onClick={() => accept.mutate()} data-testid="accept-invite">
                  {accept.isPending ? "Please wait…" : "Join this organization"}
                </button>
              ) : (
                <div className="card bg-panel p-3 text-xs text-ink-2 mb-4 text-left">
                  This invite is for <b>{invite.data.email}</b>. Sign in with that email address to use it, or ask your admin for an invite to <b>{data.email}</b>.
                </div>
              )}
              {accept.isError && (
                <p role="alert" className="text-alert text-sm mt-3">
                  {accept.error.message}
                </p>
              )}
              <button className="btn w-full justify-center mt-3" onClick={logout}>
                Sign in with a different account
              </button>
            </>
          )
        ) : restricted ? (
          <>
            <div className="card bg-panel p-3 text-xs text-ink-2 mb-4 text-left">
              Monitoring is invite-only right now. <b>{email}</b> doesn't have access yet. Ask a Monitoring admin to invite you, then open the invite link.
            </div>
            <button className="btn w-full justify-center" onClick={logout}>
              Sign in with a different account
            </button>
          </>
        ) : (
          <>
            {!token && !setup && oidc.data?.enabled && (
              <a className="btn w-full justify-center h-10 mb-3 flex items-center" href="/api/auth/oidc/start" data-testid="login-sso">
                Sign in with SSO
              </a>
            )}
            {(!token || invite.data) && (
              <form
                className="text-left space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit.mutate();
                }}
              >
                {setup && data?.setupTokenRequired && (
                  <label className="block text-xs">
                    Setup token
                    <input
                      className="input w-full mt-1 mono"
                      required
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      autoComplete="off"
                      data-testid="setup-token"
                    />
                    <span className="text-ink-3">Printed in the server log at startup, or the value of MONITORING_SETUP_TOKEN.</span>
                  </label>
                )}
                {setup && (
                  <label className="block text-xs">
                    Organization name
                    <input
                      className="input w-full mt-1"
                      required
                      maxLength={150}
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      autoComplete="organization"
                    />
                  </label>
                )}
                <label className="block text-xs">
                  Email
                  <input
                    className="input w-full mt-1"
                    type="email"
                    required
                    value={invite.data?.email ?? address}
                    readOnly={!!token}
                    onChange={(e) => setAddress(e.target.value)}
                    autoComplete="username"
                    data-testid="login-email"
                  />
                </label>
                <label className="block text-xs">
                  Password
                  <input
                    className="input w-full mt-1"
                    type="password"
                    required
                    minLength={12}
                    maxLength={256}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={setup || token ? "new-password" : "current-password"}
                    data-testid="login-password"
                  />
                </label>
                {(setup || token) && <p className="text-xs text-ink-3">Use at least 12 characters. Keep your password somewhere safe.</p>}
                {submit.isError && (
                  <p role="alert" className="text-alert text-sm">
                    {submit.error.message}
                  </p>
                )}
                <button className="btn-primary w-full justify-center h-10" disabled={submit.isPending} data-testid="login">
                  {submit.isPending ? "Please wait…" : setup ? "Create admin account" : token ? "Set password and join" : "Log in"}
                </button>
              </form>
            )}
          </>
        )}
        <p className="text-[11px] text-ink-3 mt-4">
          {token ? (
            <a href="/login" className="text-primary">
              Already have an account? Log in
            </a>
          ) : (
            "New members: ask your admin for an invite link."
          )}
        </p>
      </div>
    </div>
  );
}

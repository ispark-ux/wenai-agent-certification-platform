"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import StatusBadge from "@/components/StatusBadge";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, percentColor } from "@/lib/format";

const EMPTY = { id: null, name: "", email: "", employee_id: "", process_id: "" };

function AgentsContent() {
  const searchParams = useSearchParams();
  const [processes, setProcesses] = useState([]);
  const [agents, setAgents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [filter, setFilter] = useState(searchParams.get("process") || "all");
  const [form, setForm] = useState({ ...EMPTY, process_id: searchParams.get("process") || "" });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [emailReady, setEmailReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a, c, h] = await Promise.all([api.listProcesses(true), api.listAgents(), api.listCertifications(), api.health().catch(() => null)]);
      setProcesses(p.processes || []);
      setAgents(a.agents || []);
      setSessions(c.certifications || []);
      setEmailReady(Boolean(h?.email_configured));
      setForm((f) => ({ ...f, process_id: f.process_id || p.processes?.[0]?.process_id || "" }));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { name: form.name, email: form.email, employee_id: form.employee_id, process_id: form.process_id || null };
      if (form.id) await api.updateAgent(form.id, payload);
      else await api.createAgent(payload);
      setForm({ ...EMPTY, process_id: form.process_id });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const edit = (a) => {
    setForm({ id: a.id, name: a.name || "", email: a.email || "", employee_id: a.employee_id || "", process_id: a.process_id || "" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (a) => {
    if (!window.confirm(`Remove agent ${a.name}? Past certifications are kept.`)) return;
    setBusyId(a.id);
    try {
      await api.deleteAgent(a.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const sendLink = async (a) => {
    setBusyId(a.id);
    setNotice(null);
    setError(null);
    try {
      const data = await api.inviteAgent(a.id, { send_email: Boolean(a.email) });
      const url = `${window.location.origin}/certification/${data.session.session_id}`;
      const email = data.email;
      setNotice({
        tone: email?.status === "sent" ? "success" : email?.status === "failed" ? "warning" : "info",
        title: email?.status === "sent" ? `Link emailed to ${a.email}` : email?.status === "failed" ? `Link created, but the email failed: ${email.error}` : "Link created (no email sent)",
        url,
        sessionId: data.session.session_id,
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const processName = (id) => processes.find((p) => p.process_id === id)?.process_name || id || "—";
  const lastSession = (agentId) => sessions.find((s) => s.agent_id === agentId) || null;
  const visible = agents.filter((a) => filter === "all" || a.process_id === filter);

  return (
    <>
      {error ? (
        <Alert tone="error" className="mb-4" title="Error">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone={notice.tone} className="mb-4" title={notice.title}>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="mono text-xs">{notice.url}</span>
            <Button size="sm" variant="secondary" onClick={() => copy(notice.url)}>
              Copy link
            </Button>
            <Button size="sm" variant="ghost" href={`/admin/certification/${notice.sessionId}`}>
              View session
            </Button>
          </div>
        </Alert>
      ) : null}
      {!emailReady ? (
        <Alert tone="warning" className="mb-4" title="Email is not configured">
          Links will be created, but they cannot be emailed until SMTP is set up in <a className="font-semibold underline" href="/admin/settings">Email settings</a>. You can still copy and share links manually.
        </Alert>
      ) : null}

      <Card title={form.id ? "Edit agent" : "Add agent"} subtitle="Add an agent to a process. Use “Send link” to create a certification and email it to the agent.">
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-5">
          <Field label="Name" required>
            <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Agent name" required />
          </Field>
          <Field label="Email">
            <input type="email" className={inputClass} value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="agent@company.com" />
          </Field>
          <Field label="Employee ID">
            <input className={inputClass} value={form.employee_id} onChange={(e) => set("employee_id", e.target.value)} placeholder="EMP1024" />
          </Field>
          <Field label="Process" required>
            <select className={inputClass} value={form.process_id} onChange={(e) => set("process_id", e.target.value)} required>
              <option value="">Select…</option>
              {processes.map((p) => (
                <option key={p.process_id} value={p.process_id}>
                  {p.process_name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" loading={saving} disabled={saving} className="w-full">
              {form.id ? "Save" : "Add agent"}
            </Button>
            {form.id ? (
              <Button type="button" variant="ghost" onClick={() => setForm({ ...EMPTY, process_id: form.process_id })}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card
        className="mt-6"
        title={`Agents (${visible.length})`}
        padded={false}
        actions={
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All processes</option>
            {processes.map((p) => (
              <option key={p.process_id} value={p.process_id}>
                {p.process_name}
              </option>
            ))}
          </select>
        }
      >
        {visible.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No agents yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Agent</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Process</th>
                  <th className="px-4 py-2.5">Last certification</th>
                  <th className="px-4 py-2.5">Score</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((a) => {
                  const last = lastSession(a.id);
                  return (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-slate-800">{a.name}</p>
                        {a.employee_id ? <p className="text-xs text-slate-500">{a.employee_id}</p> : null}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{a.email || <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-2.5 text-slate-700">{processName(a.process_id)}</td>
                      <td className="px-4 py-2.5">
                        {last ? (
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={last.status} />
                            <span className="text-xs text-slate-500">{formatDateTime(last.created_at)}</span>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {last?.result_summary ? <span className={`font-bold ${percentColor(last.result_summary.percentage)}`}>{last.result_summary.percentage}%</span> : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" onClick={() => sendLink(a)} loading={busyId === a.id} disabled={!a.process_id}>
                            {a.email ? "Send link" : "Create link"}
                          </Button>
                          {last ? (
                            <Button size="sm" variant="ghost" href={`/admin/certification/${last.session_id}`}>
                              View
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => edit(a)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => remove(a)} disabled={busyId === a.id}>
                            Remove
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function AgentsPage() {
  return (
    <AdminShell title="Agents" subtitle="Add agents to a process and send them their certification link by email.">
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <AgentsContent />
      </Suspense>
    </AdminShell>
  );
}

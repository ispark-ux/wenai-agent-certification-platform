"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import StatusBadge from "@/components/StatusBadge";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration, percentColor } from "@/lib/format";

function EmailDot({ status, label }) {
  if (!status) return null;
  const s = status.status;
  const color = s === "sent" ? "bg-emerald-500" : s === "failed" ? "bg-rose-500" : "bg-slate-300";
  const title = `${label}: ${s}${status.error ? ` - ${status.error}` : ""}${status.team?.error ? ` - ${status.team.error}` : ""}`;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500" title={title}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function CertificationsContent() {
  const searchParams = useSearchParams();
  const [processes, setProcesses] = useState([]);
  const [agents, setAgents] = useState([]);
  const [rows, setRows] = useState([]);
  const [health, setHealth] = useState(null);
  const [processId, setProcessId] = useState(searchParams.get("process") || "");
  const [agentId, setAgentId] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const [p, a, c, h] = await Promise.all([api.listProcesses(), api.listAgents().catch(() => ({ agents: [] })), api.listCertifications(), api.health().catch(() => null)]);
      setProcesses(p.processes || []);
      setAgents(a.agents || []);
      setRows(c.certifications || []);
      setHealth(h);
      setProcessId((cur) => cur || p.processes?.[0]?.process_id || "");
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const processAgents = agents.filter((a) => !processId || a.process_id === processId || !a.process_id);
  const selectedAgent = agents.find((a) => a.id === agentId) || null;
  const emailReady = Boolean(health?.email_configured);

  const create = async () => {
    if (!processId) return;
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const data = await api.createCertification({ process_id: processId, agent_id: agentId || null, send_email: Boolean(agentId && selectedAgent?.email && sendEmail && emailReady) });
      setCreated({ ...data, url: `${window.location.origin}${data.certification_path}` });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const recert = async (row) => {
    setBusyId(row.session_id);
    setError(null);
    try {
      let d;
      try {
        d = await api.recertify(row.session_id, { send_email: emailReady });
      } catch (err) {
        if (err.status === 409 && /Maximum attempts|Cooldown/i.test(err.message) && window.confirm(`${err.message}\n\nOverride and create the recertification anyway?`)) {
          d = await api.recertify(row.session_id, { send_email: emailReady, force: true });
        } else throw err;
      }
      const url = `${window.location.origin}/certification/${d.session.session_id}`;
      setCreated({ session: d.session, url, certification_path: `/certification/${d.session.session_id}`, email: d.email, recert: d });
      await load();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const resend = async (row, kind) => {
    setBusyId(row.session_id);
    setError(null);
    try {
      if (kind === "invite") await api.resendInvite(row.session_id);
      else await api.resendResult(row.session_id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const visible = rows.filter((r) => {
    if (filter === "completed") return r.status === "completed";
    if (filter === "pending") return !["completed", "error"].includes(r.status);
    if (filter === "error") return r.status === "error";
    return true;
  });

  const completed = rows.filter((r) => r.status === "completed");
  const avg = completed.length ? Math.round((completed.reduce((s, r) => s + (Number(r.result_summary?.percentage) || 0), 0) / completed.length) * 10) / 10 : null;
  const passRate = completed.length ? Math.round((completed.filter((r) => r.result_summary?.passed).length / completed.length) * 100) : null;

  return (
    <>
      {health && !health.gemini_configured ? (
        <Alert tone="warning" className="mb-4" title="GEMINI_API_KEY is not set on the server">
          Add it to <span className="mono">.env</span> and restart. Links can be created, but live calls and evaluations will fail until then.
        </Alert>
      ) : null}
      {health && health.database_ok === false ? (
        <Alert tone="error" className="mb-4" title="Supabase is not reachable">
          {health.database_error}
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" className="mb-4" title="Error">
          {error}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Create certification link" subtitle="Choose the process (and optionally an agent). The link opens the live AI call; the score is emailed when it ends.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Process" required>
              <select
                className={inputClass}
                value={processId}
                onChange={(e) => {
                  setProcessId(e.target.value);
                  setAgentId("");
                }}
              >
                {processes.length === 0 ? <option value="">No process - add one first</option> : null}
                {processes.map((p) => (
                  <option key={p.process_id} value={p.process_id}>
                    {p.process_name} · {p.scenario?.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent (optional)" hint={processAgents.length === 0 ? "No agents in this process yet - add them under Agents." : "The link is bound to this agent and can be emailed."}>
              <select className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Open link (agent enters name)</option>
                {processAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.email ? ` · ${a.email}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            {selectedAgent?.email ? (
              <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={sendEmail && emailReady} disabled={!emailReady} onChange={(e) => setSendEmail(e.target.checked)} />
                Email the link to {selectedAgent.email}
                {!emailReady ? <span className="text-xs text-amber-600">(configure Email settings first)</span> : null}
              </label>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={create} loading={creating} disabled={creating || !processId}>
              Create Certification Link
            </Button>
            <Button variant="ghost" href="/admin/processes">
              Manage processes
            </Button>
          </div>

          {created ? (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="mono text-lg font-bold text-emerald-900">
                  {created.session.session_id}
                  {created.recert ? <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 align-middle text-xs font-semibold text-amber-800">Recertification · attempt {created.recert.attempt_no}/{created.recert.max_attempts}{created.recert.reused ? " · existing link reused" : ""}</span> : null}
                </p>
                {created.email ? <StatusBadge status={created.email.status === "sent" ? "completed" : created.email.status === "failed" ? "error" : "created"} label={created.email.status === "sent" ? `Emailed to ${created.session.agent_email}` : created.email.status === "failed" ? `Email failed: ${created.email.error}` : "Email skipped"} /> : null}
              </div>
              <div className="mt-3 flex gap-2">
                <input readOnly value={created.url} className={`${inputClass} mono`} onFocus={(e) => e.target.select()} />
                <Button onClick={() => copy(created.url)} variant={copied ? "success" : "primary"}>
                  {copied ? "Copied ✓" : "Copy"}
                </Button>
                <Button href={created.certification_path} target="_blank" rel="noreferrer" variant="secondary">
                  Open
                </Button>
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="Overview">
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Total</dt>
              <dd className="text-2xl font-bold text-slate-900">{rows.length}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Completed</dt>
              <dd className="text-2xl font-bold text-emerald-600">{completed.length}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Average score</dt>
              <dd className={`text-2xl font-bold ${percentColor(avg)}`}>{avg !== null ? `${avg}%` : "—"}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Pass rate</dt>
              <dd className="text-2xl font-bold text-slate-900">{passRate !== null ? `${passRate}%` : "—"}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Certifications"
        padded={false}
        actions={
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="pending">Pending / live</option>
            <option value="error">Errors</option>
          </select>
        }
      >
        {visible.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No certifications yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Session</th>
                  <th className="px-4 py-2.5">Agent</th>
                  <th className="px-4 py-2.5">Process</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Duration</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Score</th>
                  <th className="px-4 py-2.5">Emails</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => (
                  <tr key={r.session_id} className="hover:bg-slate-50">
                    <td className="mono px-4 py-2.5 text-xs text-slate-700">{r.session_id}</td>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">
                        {r.agent_name || <span className="text-slate-400">—</span>}
                        {(r.attempt_no || 1) > 1 ? <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Attempt {r.attempt_no}</span> : null}
                      </p>
                      {r.agent_email ? <p className="text-xs text-slate-500">{r.agent_email}</p> : null}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      <p>{r.process_name}</p>
                      <p className="text-xs text-slate-500">{r.scenario_title}</p>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{formatDateTime(r.started_at || r.created_at)}</td>
                    <td className="mono px-4 py-2.5 text-xs text-slate-600">{r.duration_seconds !== null && r.duration_seconds !== undefined ? formatDuration(r.duration_seconds) : "—"}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      {r.result_summary ? (
                        <span className={`font-bold ${percentColor(r.result_summary.percentage)}`}>
                          {r.result_summary.percentage}%{r.result_summary.ztp_failed ? <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] text-rose-700">ZTP</span> : null}
                          <span className="block text-[11px] font-normal text-slate-400">
                            {r.result_summary.total_marks}/{r.result_summary.applicable_marks} · {r.result_summary.passed ? "Pass" : "Fail"}
                          </span>
                          {r.result_summary.screen_video_analyzed ? (
                            <span className="block text-[11px] font-normal">
                              <span className={r.result_summary.screen_portal_verdict === "pass" ? "text-emerald-600" : r.result_summary.screen_portal_verdict === "fail" ? "text-rose-600" : "text-slate-400"}>Portal {r.result_summary.screen_portal_verdict || "?"}</span>
                              {" · "}
                              <span className={r.result_summary.screen_crm_verdict === "pass" ? "text-emerald-600" : r.result_summary.screen_crm_verdict === "fail" ? "text-rose-600" : "text-slate-400"}>CRM {r.result_summary.screen_crm_verdict || "?"}</span>
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <EmailDot status={r.invite_email} label="Link" />
                        <EmailDot status={r.result_email} label="Result" />
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="secondary" href={`/admin/certification/${r.session_id}`}>
                          {r.status === "completed" ? "View score" : "View"}
                        </Button>
                        {r.status !== "completed" ? (
                          <Button size="sm" variant="ghost" href={`/certification/${r.session_id}`} target="_blank" rel="noreferrer">
                            Open link
                          </Button>
                        ) : null}
                        {r.agent_email && r.status !== "completed" && emailReady ? (
                          <Button size="sm" variant="ghost" onClick={() => resend(r, "invite")} loading={busyId === r.session_id}>
                            Resend link
                          </Button>
                        ) : null}
                        {r.status === "completed" && emailReady ? (
                          <Button size="sm" variant="ghost" onClick={() => resend(r, "result")} loading={busyId === r.session_id}>
                            Resend result
                          </Button>
                        ) : null}
                        {(r.status === "completed" || r.status === "error") && (r.agent_name || r.agent_email) && !r.result_summary?.passed ? (
                          <Button size="sm" variant="primary" onClick={() => recert(r)} loading={busyId === r.session_id}>
                            Recertify
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function AdminHomePage() {
  return (
    <AdminShell title="Certifications" subtitle="Create links, track live sessions and review scores." wide>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <CertificationsContent />
      </Suspense>
    </AdminShell>
  );
}

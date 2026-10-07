"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import StatusBadge from "@/components/StatusBadge";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

export default function ProcessesPage() {
  const [processes, setProcesses] = useState(null);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.listProcesses(true), api.listAgents().catch(() => ({ agents: [] }))]);
      setProcesses(p.processes || []);
      setAgents(a.agents || []);
      setError(null);
    } catch (err) {
      setError(err.message);
      setProcesses([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async (p) => {
    setBusyId(p.process_id);
    try {
      await api.updateProcess(p.process_id, { active: !p.active });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete process "${p.process_name}"? Existing certifications keep their results, but no new links can be created.`)) return;
    setBusyId(p.process_id);
    try {
      await api.deleteProcess(p.process_id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AdminShell title="Processes" subtitle="Each process has its own AI customer prompt, scenario and scorecard." actions={<Button href="/admin/processes/new">+ Add process</Button>}>
      {error ? (
        <Alert tone="error" className="mb-4" title="Error">
          {error}
        </Alert>
      ) : null}
      {!processes ? (
        <div className="flex items-center gap-2 text-slate-500">
          <Spinner /> Loading…
        </div>
      ) : processes.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">No processes yet. Click “Add process”, write the AI prompt for the customer scenario, and the scorecard is pre-filled with the standard 17 parameters.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {processes.map((p) => {
            const agentCount = agents.filter((a) => a.process_id === p.process_id).length;
            return (
              <Card key={p.process_id} className={p.active ? "" : "opacity-70"}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">{p.process_name}</h3>
                    <p className="text-sm text-slate-500">{p.tagline || p.description || "—"}</p>
                  </div>
                  <StatusBadge status={p.active ? "completed" : "created"} label={p.active ? "Active" : "Inactive"} />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Process ID</dt>
                    <dd className="mono font-medium text-slate-800">{p.process_id}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Scenario</dt>
                    <dd className="font-medium text-slate-800">{p.scenario?.title || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Customer · Language</dt>
                    <dd className="font-medium text-slate-800">
                      {p.customer_profile?.name || "—"} · {p.language || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Scorecard</dt>
                    <dd className="font-medium text-slate-800">
                      {p.rubric?.length || 0} parameters · {p.maximum_marks} marks · pass {p.scoring?.passing_percentage ?? 80}%
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Agents</dt>
                    <dd className="font-medium text-slate-800">{agentCount}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">AI prompt</dt>
                    <dd className="font-medium text-slate-800">{p.ai_prompt ? `${p.ai_prompt.length} chars` : "legacy scenario"}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-1">
                  {(p.groups || []).map((g) => (
                    <span key={g.group} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {g.group} {g.max_marks}
                    </span>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button size="sm" href={`/admin/processes/${p.process_id}`}>
                    Edit
                  </Button>
                  <Button size="sm" variant="secondary" href={`/admin?process=${p.process_id}`}>
                    Create link
                  </Button>
                  <Button size="sm" variant="secondary" href={`/admin/agents?process=${p.process_id}`}>
                    Agents
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(p)} loading={busyId === p.process_id}>
                    {p.active ? "Deactivate" : "Activate"}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => remove(p)} disabled={busyId === p.process_id}>
                    Delete
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </AdminShell>
  );
}

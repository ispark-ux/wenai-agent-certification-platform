"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Spinner } from "@/components/ui";
import { AgentsTab, OverviewTab, ParetoTab, ProcessesTab } from "@/components/analytics/AnalyticsTabs";
import { api } from "@/lib/api";

const TABS = [
  { id: "overview", label: "Certification analysis" },
  { id: "processes", label: "Process-wise" },
  { id: "agents", label: "Agent-wise" },
  { id: "pareto", label: "Pareto" },
];

const RANGES = [
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "365", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

function AnalyticsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "overview";
  const processId = params.get("process") || "";
  const range = RANGES.some((r) => r.id === params.get("range")) ? params.get("range") : "30";

  const [processes, setProcesses] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const setParam = useCallback(
    (key, value) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  const from = useMemo(() => (range === "all" ? null : new Date(Date.now() - Number(range) * 86400000).toISOString()), [range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.analytics({ process_id: processId, from });
      setData(d);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [processId, from]);

  useEffect(() => {
    api.listProcesses(true).then((d) => setProcesses(d.processes || [])).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const passing = useMemo(() => {
    const p = processes.find((x) => x.process_id === processId);
    return Number(p?.scoring?.passing_percentage) || 80;
  }, [processes, processId]);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setParam("tab", t.id)} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === t.id ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm" value={processId} onChange={(e) => setParam("process", e.target.value)}>
            <option value="">All processes</option>
            {processes.map((p) => (
              <option key={p.process_id} value={p.process_id}>
                {p.process_name}
              </option>
            ))}
          </select>
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm" value={range} onChange={(e) => setParam("range", e.target.value)}>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={load} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="error" className="mb-4" title="Could not load analytics">
          {error}
        </Alert>
      ) : null}
      {!data && loading ? (
        <div className="flex items-center gap-2 py-16 text-slate-500">
          <Spinner /> Crunching the numbers…
        </div>
      ) : null}

      {data ? (
        <div className={loading ? "opacity-60 transition" : "transition"}>
          {tab === "overview" ? <OverviewTab data={data} passing={passing} /> : null}
          {tab === "processes" ? <ProcessesTab data={data} /> : null}
          {tab === "agents" ? <AgentsTab data={data} passing={passing} onChanged={load} /> : null}
          {tab === "pareto" ? <ParetoTab data={data} /> : null}
          <p className="mt-6 text-right text-[11px] text-slate-400">Generated {new Date(data.generated_at).toLocaleString()}</p>
        </div>
      ) : null}
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <AdminShell title="Analytics" subtitle="Certification, process-wise, agent-wise and Pareto analysis - with recertification." wide>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <AnalyticsContent />
      </Suspense>
    </AdminShell>
  );
}

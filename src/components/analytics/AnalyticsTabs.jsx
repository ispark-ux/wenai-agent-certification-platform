"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Alert, Button, Card, inputClass } from "@/components/ui";
import { BarList, Histogram, Kpi, ParetoChart, Sparkline, TrendChart, downloadCsv, textToneFor } from "@/components/analytics/Charts";
import { formatDateTime, formatDuration } from "@/lib/format";
import { api } from "@/lib/api";

const pctText = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const verdictCounts = (obj = {}) => Object.entries(obj).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(" · ") || "—";

// ============================================================================ Certification analysis
export function OverviewTab({ data, passing }) {
  const o = data.overview;
  const worst = data.parameters.slice(0, 8);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Links" value={o.links} hint={`${o.created} unused · ${o.in_progress} in progress`} />
        <Kpi label="Completed" value={o.completed} hint={`${o.errors} errors`} />
        <Kpi label="Pass rate" value={pctText(o.pass_rate)} tone={textToneFor(o.pass_rate, passing)} hint={`${o.passed} pass · ${o.failed} fail`} />
        <Kpi label="Average score" value={pctText(o.avg_score)} tone={textToneFor(o.avg_score, passing)} hint={`median ${pctText(o.median_score)}`} />
        <Kpi label="First-attempt pass" value={pctText(o.first_attempt.pass_rate)} hint={`${o.first_attempt.completed} first attempts`} />
        <Kpi label="Recert pass" value={pctText(o.recertifications.pass_rate)} hint={`${o.recertifications.completed} recertifications`} />
        <Kpi label="ZTP failures" value={o.ztp_failures} tone={o.ztp_failures ? "text-rose-600" : "text-slate-900"} hint="Zero-tolerance breaches" />
        <Kpi label="Avg call" value={o.avg_duration_seconds ? formatDuration(o.avg_duration_seconds) : "—"} hint={`${o.agents_certified}/${o.agents_total} agents certified`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Daily trend" subtitle="Bars = completed certifications · line = average score" className="lg:col-span-2">
          <TrendChart points={o.trend} passing={passing} />
        </Card>
        <Card title="Score distribution" subtitle={`Passing mark ${passing}%`}>
          <Histogram buckets={o.distribution} passing={passing} />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Section-wise performance" subtitle="Marks earned ÷ applicable marks (NA excluded)">
          <BarList passing={passing} rows={data.sections.map((g) => ({ label: `${g.group} (max ${g.max_marks})`, value: g.percentage, display: pctText(g.percentage), sub: `${g.marks_lost} marks lost · NA in ${g.na_rate ?? 0}% of calls` }))} />
        </Card>
        <Card title="Weakest parameters" subtitle="Ranked by total marks lost">
          <BarList passing={passing} rows={worst.map((p) => ({ label: `${p.id} ${p.parameter}`, value: p.compliance_pct, display: pctText(p.compliance_pct), sub: `${p.marks_lost} marks lost · NC ${p.NC} · C ${p.C} · NA ${p.NA}${p.zero_tolerance ? " · ZTP" : ""}` }))} />
        </Card>
      </div>

      <Card title="Portal & CRM verification" subtitle={`${data.screen.analysed} screen recordings analysed by Gemini`}>
        {data.screen.analysed ? (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-slate-500">Portal work:</span> <span className="font-medium">{verdictCounts(data.screen.portal)}</span>
              </p>
              <p>
                <span className="text-slate-500">CRM tagging:</span> <span className="font-medium">{verdictCounts(data.screen.crm)}</span>
              </p>
              <p>
                <span className="text-slate-500">Screen vs speech:</span> <span className="font-medium">{verdictCounts(data.screen.consistency)}</span>
              </p>
            </div>
            <div className="lg:col-span-2">
              <BarList
                rows={data.screen.checks
                  .filter((c) => c.pass + c.fail + c.partial > 0)
                  .sort((a, b) => (a.pass_rate ?? 0) - (b.pass_rate ?? 0))
                  .map((c) => ({ label: c.title, value: c.pass_rate, display: pctText(c.pass_rate), sub: `pass ${c.pass} · fail ${c.fail} · partial ${c.partial} · unclear ${c.unclear}` }))}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No analysed screen recordings in this period.</p>
        )}
      </Card>

      <Card
        title="Parameter-wise analysis"
        padded={false}
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              downloadCsv("parameter-analysis.csv", data.parameters, [
                { label: "ID", value: "id" },
                { label: "Section", value: "group" },
                { label: "Parameter", value: "parameter" },
                { label: "Max marks", value: "max_marks" },
                { label: "Evaluated", value: "evaluated" },
                { label: "C", value: "C" },
                { label: "NC", value: "NC" },
                { label: "NA", value: "NA" },
                { label: "Compliance %", value: "compliance_pct" },
                { label: "Marks lost", value: "marks_lost" },
              ])
            }
          >
            Export CSV
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Parameter</th>
                <th className="px-4 py-2 text-center">C</th>
                <th className="px-4 py-2 text-center">NC</th>
                <th className="px-4 py-2 text-center">NA</th>
                <th className="px-4 py-2 text-center">NC rate</th>
                <th className="px-4 py-2 text-center">Compliance</th>
                <th className="px-4 py-2 text-center">Marks lost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.parameters.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2">
                    <span className="mono mr-2 text-xs text-slate-400">{p.id}</span>
                    <span className="font-medium text-slate-800">{p.parameter}</span>
                    {p.zero_tolerance ? <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] font-bold text-rose-700">ZTP</span> : null}
                    <span className="block text-[11px] text-slate-400">{p.group}</span>
                  </td>
                  <td className="px-4 py-2 text-center text-emerald-600">{p.C}</td>
                  <td className="px-4 py-2 text-center text-rose-600">{p.NC}</td>
                  <td className="px-4 py-2 text-center text-slate-400">{p.NA}</td>
                  <td className="px-4 py-2 text-center">{pctText(p.nc_rate)}</td>
                  <td className={`px-4 py-2 text-center font-semibold ${textToneFor(p.compliance_pct, passing)}`}>{pctText(p.compliance_pct)}</td>
                  <td className="px-4 py-2 text-center font-semibold text-slate-800">{p.marks_lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.parameters.length ? <p className="px-5 py-6 text-sm text-slate-400">No completed certifications in this period.</p> : null}
        </div>
      </Card>
    </div>
  );
}

// ============================================================================ Process-wise
export function ProcessesTab({ data }) {
  if (!data.processes.length) return <Card><p className="text-sm text-slate-500">No processes yet.</p></Card>;
  return (
    <div className="space-y-6">
      <Card
        title="Process comparison"
        padded={false}
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              downloadCsv("process-analysis.csv", data.processes, [
                { label: "Process", value: "process_name" },
                { label: "Scenario", value: "scenario_title" },
                { label: "Links", value: "links" },
                { label: "Completed", value: "completed" },
                { label: "Pass rate %", value: "pass_rate" },
                { label: "Avg score %", value: "avg_score" },
                { label: "Min %", value: "min_score" },
                { label: "Max %", value: "max_score" },
                { label: "Agents", value: "agents" },
                { label: "Certified agents", value: "certified_agents" },
                { label: "ZTP failures", value: "ztp_failures" },
                { label: "Top defect", value: (r) => r.top_defects[0]?.label || "" },
              ])
            }
          >
            Export CSV
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Process</th>
                <th className="px-4 py-2 text-center">Links</th>
                <th className="px-4 py-2 text-center">Completed</th>
                <th className="px-4 py-2 text-center">Pass rate</th>
                <th className="px-4 py-2 text-center">Avg score</th>
                <th className="px-4 py-2 text-center">Range</th>
                <th className="px-4 py-2 text-center">Agents certified</th>
                <th className="px-4 py-2 text-center">ZTP</th>
                <th className="px-4 py-2">Top defect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.processes.map((p) => (
                <tr key={p.process_id}>
                  <td className="px-4 py-2">
                    <p className="font-semibold text-slate-800">{p.process_name}</p>
                    <p className="text-xs text-slate-500">
                      {p.scenario_title}
                      {!p.active ? " · inactive" : ""}
                    </p>
                  </td>
                  <td className="px-4 py-2 text-center">{p.links}</td>
                  <td className="px-4 py-2 text-center">{p.completed}</td>
                  <td className={`px-4 py-2 text-center font-semibold ${textToneFor(p.pass_rate, p.passing_percentage)}`}>{pctText(p.pass_rate)}</td>
                  <td className={`px-4 py-2 text-center font-semibold ${textToneFor(p.avg_score, p.passing_percentage)}`}>{pctText(p.avg_score)}</td>
                  <td className="px-4 py-2 text-center text-xs text-slate-500">{p.min_score !== null ? `${p.min_score}–${p.max_score}%` : "—"}</td>
                  <td className="px-4 py-2 text-center">
                    {p.certified_agents}/{p.agents}
                  </td>
                  <td className={`px-4 py-2 text-center ${p.ztp_failures ? "font-bold text-rose-600" : "text-slate-400"}`}>{p.ztp_failures}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">{p.top_defects[0] ? `${p.top_defects[0].key} ${p.top_defects[0].label} (${p.top_defects[0].value} marks)` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {data.processes.map((p) => (
          <Card key={p.process_id} title={p.process_name} subtitle={`${p.completed} completed · pass ${pctText(p.pass_rate)} · avg ${pctText(p.avg_score)} · passing ${p.passing_percentage}%`}>
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Sections</p>
                <BarList passing={p.passing_percentage} rows={p.sections.map((g) => ({ label: g.group, value: g.percentage, display: pctText(g.percentage) }))} empty="No results yet." />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Top defects (marks lost)</p>
                {p.top_defects.length ? (
                  <ol className="space-y-1.5 text-sm">
                    {p.top_defects.map((d) => (
                      <li key={d.key} className="flex justify-between gap-2">
                        <span className="truncate">
                          <span className="mono mr-1 text-xs text-slate-400">{d.key}</span>
                          {d.label}
                        </span>
                        <span className={`shrink-0 font-semibold ${d.vital ? "text-rose-600" : "text-slate-600"}`}>{d.value}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-slate-400">No defects.</p>
                )}
                {p.screen.analysed ? (
                  <p className="mt-3 text-xs text-slate-500">
                    Screen: portal {verdictCounts(p.screen.portal)} · CRM {verdictCounts(p.screen.crm)}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-4">
              <TrendChart points={p.trend} passing={p.passing_percentage} />
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" href={`/admin/analytics?tab=pareto&process=${p.process_id}`}>
                Pareto for {p.process_name}
              </Button>
              <Button size="sm" variant="ghost" href={`/admin/analytics?tab=agents&process=${p.process_id}`}>
                Agents
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================================ Agent-wise
const STATUS_TONE = {
  Certified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "Not certified": "bg-rose-50 text-rose-700 ring-rose-200",
  "Failed (ZTP)": "bg-rose-100 text-rose-800 ring-rose-300",
  "In progress": "bg-violet-50 text-violet-700 ring-violet-200",
  "Link sent": "bg-sky-50 text-sky-700 ring-sky-200",
  "Not started": "bg-slate-100 text-slate-600 ring-slate-200",
};

export function AgentsTab({ data, passing, onChanged }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("recent");
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = data.agents.filter((a) => {
      if (needle && !`${a.name} ${a.email || ""} ${a.employee_id || ""} ${a.process_name}`.toLowerCase().includes(needle)) return false;
      if (status === "eligible") return a.recertification_eligible;
      if (status !== "all") return a.status === status;
      return true;
    });
    const by = {
      recent: (a, b) => String(b.last_activity || "").localeCompare(String(a.last_activity || "")),
      best: (a, b) => (b.best_score ?? -1) - (a.best_score ?? -1),
      worst: (a, b) => (a.latest_score ?? 999) - (b.latest_score ?? 999),
      attempts: (a, b) => b.attempts - a.attempts,
      improvement: (a, b) => (b.improvement ?? -999) - (a.improvement ?? -999),
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    list = [...list].sort(by[sort] || by.recent);
    return list;
  }, [data.agents, q, status, sort]);

  const eligible = data.agents.filter((a) => a.recertification_eligible && a.latest_session_id);

  const recertifyOne = async (a, force = false) => {
    setBusy(a.key);
    setNotice(null);
    try {
      const d = await api.recertify(a.latest_session_id, { send_email: true, force });
      setNotice({ tone: d.email?.status === "sent" ? "success" : "info", text: `${a.name}: recertification attempt ${d.attempt_no}/${d.max_attempts} ${d.reused ? "(existing unused link reused)" : "created"}${d.email?.status === "sent" ? ` and emailed to ${a.email}` : d.email?.status === "failed" ? ` - email failed: ${d.email.error}` : ""}.`, url: `${window.location.origin}/certification/${d.session.session_id}` });
      onChanged?.();
    } catch (err) {
      if (err.status === 409 && /Maximum attempts|Cooldown/i.test(err.message) && window.confirm(`${err.message}\n\nOverride and create the recertification anyway?`)) {
        setBusy(null);
        return recertifyOne(a, true);
      }
      setNotice({ tone: "error", text: `${a.name}: ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  const recertifyAll = async () => {
    if (!window.confirm(`Create recertification links for ${eligible.length} agent(s) and email them?`)) return;
    setBusy("bulk");
    let ok = 0;
    const failed = [];
    for (const a of eligible) {
      try {
        await api.recertify(a.latest_session_id, { send_email: true });
        ok += 1;
      } catch (err) {
        failed.push(`${a.name}: ${err.message}`);
      }
    }
    setNotice({ tone: failed.length ? "warning" : "success", text: `${ok} recertification link(s) created.${failed.length ? ` ${failed.length} failed - ${failed.join("; ")}` : ""}` });
    setBusy(null);
    onChanged?.();
  };

  const statuses = ["all", "Certified", "Not certified", "Failed (ZTP)", "In progress", "Link sent", "Not started", "eligible"];

  return (
    <div className="space-y-4">
      {notice ? (
        <Alert tone={notice.tone}>
          {notice.text}
          {notice.url ? <span className="mono ml-2 text-xs">{notice.url}</span> : null}
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Agents" value={data.overview.agents_total} />
        <Kpi label="Certified" value={data.overview.agents_certified} tone="text-emerald-600" />
        <Kpi label="Eligible for recert" value={data.overview.agents_pending_recert} tone={data.overview.agents_pending_recert ? "text-amber-600" : "text-slate-900"} />
        <Kpi label="Recovery rate" value={pctText(data.overview.recovery_rate)} hint="Failed first attempt → certified later" />
        <Kpi label="Avg attempts" value={data.agents.filter((a) => a.attempts).length ? (data.agents.reduce((s, a) => s + a.attempts, 0) / data.agents.filter((a) => a.attempts).length).toFixed(1) : "—"} />
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <input className={`${inputClass} max-w-xs`} placeholder="Search name, email, employee ID…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s === "eligible" ? "Eligible for recertification" : s}
              </option>
            ))}
          </select>
          <select className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">Sort: recent activity</option>
            <option value="worst">Sort: lowest latest score</option>
            <option value="best">Sort: highest best score</option>
            <option value="improvement">Sort: most improved</option>
            <option value="attempts">Sort: most attempts</option>
            <option value="name">Sort: name</option>
          </select>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={recertifyAll} loading={busy === "bulk"} disabled={!eligible.length || busy === "bulk"}>
              Recertify all eligible ({eligible.length})
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                downloadCsv("agent-analysis.csv", rows, [
                  { label: "Agent", value: "name" },
                  { label: "Email", value: "email" },
                  { label: "Employee ID", value: "employee_id" },
                  { label: "Process", value: "process_name" },
                  { label: "Status", value: "status" },
                  { label: "Attempts", value: "attempts" },
                  { label: "Max attempts", value: "max_attempts" },
                  { label: "Latest %", value: "latest_score" },
                  { label: "Best %", value: "best_score" },
                  { label: "First %", value: "first_score" },
                  { label: "Improvement", value: "improvement" },
                  { label: "ZTP failures", value: "ztp_failures" },
                  { label: "Focus areas", value: (r) => r.focus_areas.map((f) => `${f.id} ${f.parameter} (-${f.lost})`) },
                  { label: "Last activity", value: "last_activity" },
                ])
              }
            >
              Export CSV
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Process</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-center">Attempts</th>
                <th className="px-4 py-2 text-center">Latest</th>
                <th className="px-4 py-2 text-center">Best</th>
                <th className="px-4 py-2">Trend</th>
                <th className="px-4 py-2">Focus areas (latest attempt)</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((a) => (
                <FragmentRow key={a.key} a={a} passing={passing} expanded={expanded === a.key} onToggle={() => setExpanded(expanded === a.key ? null : a.key)} onRecertify={() => recertifyOne(a)} busy={busy === a.key} />
              ))}
            </tbody>
          </table>
          {!rows.length ? <p className="px-5 py-6 text-sm text-slate-400">No agents match these filters.</p> : null}
        </div>
      </Card>
    </div>
  );
}

function FragmentRow({ a, passing, expanded, onToggle, onRecertify, busy }) {
  return (
    <>
      <tr className="align-top hover:bg-slate-50">
        <td className="px-4 py-2.5">
          <button type="button" className="text-left" onClick={onToggle}>
            <p className="font-semibold text-slate-800 hover:text-brand-700">{a.name}</p>
            <p className="text-xs text-slate-500">{[a.email, a.employee_id].filter(Boolean).join(" · ") || "—"}</p>
          </button>
        </td>
        <td className="px-4 py-2.5 text-slate-700">{a.process_name}</td>
        <td className="px-4 py-2.5">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_TONE[a.status] || STATUS_TONE["Not started"]}`}>{a.status}</span>
          {a.recertification_eligible ? <span className="mt-1 block text-[11px] font-medium text-amber-600">Eligible for recertification</span> : null}
        </td>
        <td className="px-4 py-2.5 text-center">
          {a.attempts}/{a.max_attempts}
        </td>
        <td className={`px-4 py-2.5 text-center font-semibold ${textToneFor(a.latest_score, passing)}`}>{pctText(a.latest_score)}</td>
        <td className={`px-4 py-2.5 text-center ${textToneFor(a.best_score, passing)}`}>{pctText(a.best_score)}</td>
        <td className="px-4 py-2.5">
          <Sparkline values={a.trend} passing={passing} />
          {a.improvement !== null ? <span className={`block text-[11px] ${a.improvement >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{a.improvement >= 0 ? "+" : ""}{a.improvement} pts</span> : null}
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-600">
          {a.focus_areas.length ? a.focus_areas.map((f) => (
            <span key={f.id} className="mb-0.5 block">
              <span className="mono text-slate-400">{f.id}</span> {f.parameter} <span className="text-rose-600">−{f.lost}</span>
            </span>
          )) : <span className="text-slate-300">—</span>}
        </td>
        <td className="px-4 py-2.5">
          <div className="flex justify-end gap-1">
            {a.latest_session_id ? (
              <Button size="sm" variant="ghost" href={`/admin/certification/${a.latest_session_id}`}>
                View
              </Button>
            ) : null}
            {a.attempts > 0 && !a.certified ? (
              <Button size="sm" variant={a.recertification_eligible ? "primary" : "secondary"} onClick={onRecertify} loading={busy}>
                Recertify
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-slate-50">
          <td colSpan={9} className="px-6 py-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Attempt history</p>
            {a.attempts_list.length ? (
              <ol className="flex flex-wrap gap-2">
                {a.attempts_list.map((x) => (
                  <li key={x.session_id}>
                    <Link href={`/admin/certification/${x.session_id}`} className="block rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs hover:border-brand-300">
                      <span className="font-semibold">Attempt {x.attempt_no}</span> · {formatDateTime(x.date)}
                      <span className={`ml-2 font-bold ${x.passed === true ? "text-emerald-600" : x.passed === false ? "text-rose-600" : "text-slate-400"}`}>{x.percentage !== null ? `${x.percentage}%` : x.status}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-slate-400">No certification links yet - create one from the Agents page.</p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ============================================================================ Pareto
const PARETO_VIEWS = [
  { id: "parameters_by_marks", label: "Parameters · marks lost", valueLabel: "Marks lost" },
  { id: "parameters_by_defects", label: "Parameters · defect count", valueLabel: "Defects" },
  { id: "sections_by_marks", label: "Sections · marks lost", valueLabel: "Marks lost" },
  { id: "screen_checks", label: "Portal / CRM checks · failures", valueLabel: "Failures" },
];

export function ParetoTab({ data }) {
  const [view, setView] = useState("parameters_by_marks");
  const meta = PARETO_VIEWS.find((v) => v.id === view);
  const p = data.pareto[view];
  const vital = p.rows.filter((r) => r.vital);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {PARETO_VIEWS.map((v) => (
          <button key={v.id} type="button" onClick={() => setView(v.id)} className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${view === v.id ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}>
            {v.label}
          </button>
        ))}
      </div>

      <Card title="Pareto chart (80/20)" subtitle={p.rows.length ? `${p.vital_count} of ${p.item_count} items cause 80% of the ${meta.valueLabel.toLowerCase()} (total ${p.total}). Red bars = vital few.` : "No defects in this selection."}>
        <ParetoChart data={p} valueLabel={meta.valueLabel} />
      </Card>

      {vital.length ? (
        <Card title="Action plan - fix the vital few first" subtitle="Training focus derived from the Pareto analysis">
          <ol className="space-y-2">
            {vital.map((r) => (
              <li key={r.key} className="flex items-start gap-3 rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2 text-sm">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-600 text-xs font-bold text-white">{r.rank}</span>
                <div className="flex-1">
                  <p className="font-semibold text-slate-800">
                    {r.key && r.key !== r.label ? <span className="mono mr-1 text-xs text-slate-400">{r.key}</span> : null}
                    {r.label}
                  </p>
                  <p className="text-xs text-slate-600">
                    {r.value} {meta.valueLabel.toLowerCase()} · {r.share}% of total · cumulative {r.cumulative_pct}%{r.group ? ` · ${r.group}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <Card
        title="Pareto table"
        padded={false}
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={!p.rows.length}
            onClick={() =>
              downloadCsv(`pareto-${view}.csv`, p.rows, [
                { label: "Rank", value: "rank" },
                { label: "Key", value: "key" },
                { label: "Item", value: "label" },
                { label: "Group", value: "group" },
                { label: meta.valueLabel, value: "value" },
                { label: "Share %", value: "share" },
                { label: "Cumulative %", value: "cumulative_pct" },
                { label: "Vital few", value: (r) => (r.vital ? "Yes" : "No") },
              ])
            }
          >
            Export CSV
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2 text-center">{meta.valueLabel}</th>
                <th className="px-4 py-2 text-center">Share</th>
                <th className="px-4 py-2">Cumulative</th>
                <th className="px-4 py-2 text-center">Class</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.rows.map((r) => (
                <tr key={r.key || r.rank} className={r.vital ? "bg-rose-50/40" : ""}>
                  <td className="px-4 py-2 text-slate-500">{r.rank}</td>
                  <td className="px-4 py-2">
                    {r.key && r.key !== r.label ? <span className="mono mr-1 text-xs text-slate-400">{r.key}</span> : null}
                    <span className="font-medium text-slate-800">{r.label}</span>
                    {r.group ? <span className="block text-[11px] text-slate-400">{r.group}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-center font-semibold">{r.value}</td>
                  <td className="px-4 py-2 text-center">{r.share}%</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full ${r.vital ? "bg-rose-500" : "bg-slate-400"}`} style={{ width: `${r.cumulative_pct}%` }} />
                      </div>
                      <span className="text-xs text-slate-600">{r.cumulative_pct}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.vital ? "bg-rose-600 text-white" : "bg-slate-100 text-slate-500"}`}>{r.vital ? "Vital few" : "Useful many"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

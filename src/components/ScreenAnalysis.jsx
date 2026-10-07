"use client";

import { useState } from "react";
import { Card } from "@/components/ui";

const RESULT_STYLE = {
  pass: { icon: "✓", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Pass" },
  fail: { icon: "✕", cls: "bg-rose-50 text-rose-700 ring-rose-200", label: "Fail" },
  partial: { icon: "◐", cls: "bg-amber-50 text-amber-700 ring-amber-200", label: "Partial" },
  unclear: { icon: "?", cls: "bg-slate-100 text-slate-600 ring-slate-200", label: "Unclear" },
  not_applicable: { icon: "–", cls: "bg-slate-50 text-slate-400 ring-slate-200", label: "N/A" },
  observed: { icon: "✓", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Observed" },
  not_observed: { icon: "✕", cls: "bg-rose-50 text-rose-700 ring-rose-200", label: "Not observed" },
  consistent: { icon: "✓", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Consistent" },
  inconsistent: { icon: "✕", cls: "bg-rose-50 text-rose-700 ring-rose-200", label: "Inconsistent" },
};

export function VerdictPill({ value, prefix = "" }) {
  const s = RESULT_STYLE[value] || RESULT_STYLE.unclear;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${s.cls}`}>
      <span>{s.icon}</span>
      {prefix}
      {s.label}
    </span>
  );
}

function VerdictBox({ title, verdict, subtitle }) {
  const tone = verdict === "pass" ? "border-emerald-200 bg-emerald-50" : verdict === "fail" ? "border-rose-200 bg-rose-50" : verdict === "partial" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50";
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <div className="mt-1 flex items-center gap-2">
        <VerdictPill value={verdict} />
      </div>
      {subtitle ? <p className="mt-1 text-xs text-slate-600">{subtitle}</p> : null}
    </div>
  );
}

function ChecklistTable({ rows }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Check</th>
            <th className="px-3 py-2">Result</th>
            <th className="px-3 py-2">Seen on screen</th>
            <th className="px-3 py-2">Evidence</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="px-3 py-2 font-medium text-slate-800">
                {r.title}
                {r.expected_value ? <p className="mono text-[11px] font-normal text-slate-400">expected: {r.expected_value}</p> : null}
              </td>
              <td className="px-3 py-2">
                <VerdictPill value={r.result} />
              </td>
              <td className="px-3 py-2">
                {r.value_seen ? (
                  <span className={`mono text-xs ${r.expected_value && r.value_seen.replace(/\s+/g, "").toLowerCase() !== r.expected_value.replace(/\s+/g, "").toLowerCase() && r.result === "fail" ? "text-rose-700" : "text-slate-800"}`}>{r.value_seen}</span>
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-slate-600">
                {r.timestamp ? <span className="mono mr-2 text-slate-400">{r.timestamp}</span> : null}
                {r.evidence}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Portal & CRM verification report: what Gemini saw on the agent's screen -
 * verdict per check (portal opened, exact ID searched, record opened, status,
 * CRM disposition/remarks/save), screen-vs-speech cross-check, expected-action
 * status, values read from the screen, full timeline and QA concerns.
 */
export default function ScreenAnalysis({ analysis, error = null, captured = false }) {
  const [showTimeline, setShowTimeline] = useState(false);
  const [showExpected, setShowExpected] = useState(false);

  if (!analysis || !analysis.analyzed) {
    return (
      <Card title="Portal & CRM verification (screen recording)" subtitle={captured ? "The recording was captured but could not be analysed." : "No screen recording was captured."}>
        <p className="text-sm text-slate-600">{error ? `Reason: ${error}` : captured ? "Screen-based parameters were marked NA." : "Screen-based parameters were marked NA because there is no recording to verify them."}</p>
      </Card>
    );
  }

  const c = analysis.counts || {};
  const verification = analysis.verification || [];
  const portalRows = verification.filter((v) => v.category === "portal");
  const crmRows = verification.filter((v) => v.category === "crm");
  const conductRows = verification.filter((v) => v.category === "conduct");
  const cc = analysis.cross_check || {};

  return (
    <Card
      title="Portal & CRM verification (screen recording)"
      subtitle={`Gemini watched the full recording (${analysis.model || "vision model"}) · ${c.checks_pass || 0} pass · ${c.checks_fail || 0} fail · ${c.checks_partial || 0} partial · ${c.checks_unclear || 0} unclear`}
    >
      {!analysis.video_readable ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">The recording was mostly unreadable.</p>
          <p className="text-xs">{analysis.readability_notes}</p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <VerdictBox title="Portal work" verdict={analysis.portal_verdict} subtitle={portalRows.length ? `${portalRows.filter((r) => r.result === "pass").length}/${portalRows.filter((r) => r.result !== "not_applicable").length} checks passed` : "No portal checks configured"} />
        <VerdictBox title="CRM tagging" verdict={analysis.crm_verdict} subtitle={crmRows.length ? `${crmRows.filter((r) => r.result === "pass").length}/${crmRows.filter((r) => r.result !== "not_applicable").length} checks passed` : "No CRM checks configured"} />
        <VerdictBox title="Screen vs. what the agent said" verdict={cc.consistency} subtitle={cc.status_on_screen || cc.status_told_to_customer ? `Screen: ${cc.status_on_screen || "—"} · Told: ${cc.status_told_to_customer || "—"}` : null} />
      </div>
      {cc.notes ? <p className="mt-2 text-xs text-slate-600">{cc.notes}</p> : null}

      <p className="mt-4 text-sm leading-relaxed text-slate-700">{analysis.summary}</p>
      {analysis.applications_seen?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {analysis.applications_seen.map((a, i) => (
            <span key={i} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-[11px] font-medium text-brand-700">
              {a}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-5 space-y-5">
        {portalRows.length ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Portal checks</p>
            <ChecklistTable rows={portalRows} />
          </div>
        ) : null}
        {crmRows.length ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">CRM / tagging checks</p>
            <ChecklistTable rows={crmRows} />
          </div>
        ) : null}
        {conductRows.length ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Conduct</p>
            <ChecklistTable rows={conductRows} />
          </div>
        ) : null}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {analysis.key_facts_seen?.length ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Values read from the screen</p>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {analysis.key_facts_seen.map((f, i) => (
                  <tr key={i}>
                    <td className="mono py-1.5 pr-2 text-xs text-slate-400">{f.timestamp}</td>
                    <td className="py-1.5 pr-2 text-slate-600">{f.fact}</td>
                    <td className="mono py-1.5 text-xs font-medium text-slate-900">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {analysis.concerns?.length ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Concerns</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-rose-900">
              {analysis.concerns.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-4 text-xs">
        <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => setShowExpected((v) => !v)}>
          {showExpected ? "Hide" : "Show"} expected actions ({c.observed || 0} observed / {c.not_observed || 0} not observed / {c.unclear || 0} unclear)
        </button>
        <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => setShowTimeline((v) => !v)}>
          {showTimeline ? "Hide" : "Show"} full on-screen timeline ({analysis.observed_actions?.length || 0} actions)
        </button>
      </div>
      {showExpected ? (
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {analysis.expected_actions.map((a, i) => (
            <li key={i} className="flex flex-wrap items-start gap-3 px-3 py-2 text-sm">
              <VerdictPill value={a.status} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">
                  {a.action} <span className="text-xs font-normal text-slate-400">({a.category})</span>
                </p>
                <p className="text-xs text-slate-500">
                  {a.timestamp ? <span className="mono mr-2 text-slate-400">{a.timestamp}</span> : null}
                  {a.evidence}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {showTimeline ? (
        <ol className="scroll-thin mt-2 max-h-80 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 p-3">
          {analysis.observed_actions.map((o, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="mono w-12 shrink-0 text-xs text-slate-400">{o.timestamp}</span>
              <div>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{o.application}</span> <span className="text-slate-800">{o.action}</span>
                {o.details ? <p className="text-xs text-slate-500">{o.details}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}

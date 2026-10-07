"use client";

import { useState } from "react";
import StatusBadge from "@/components/StatusBadge";
import { formatDuration } from "@/lib/format";

const SOURCE_LABEL = {
  transcript: "Transcript",
  audio: "Audio",
  screen: "Screen",
  both: "Transcript + Screen",
};

function StatusIcon({ status }) {
  if (status === "C") return <span className="text-lg font-bold text-emerald-600">✓</span>;
  if (status === "NC") return <span className="text-lg font-bold text-rose-600">✕</span>;
  return <span className="text-sm font-bold text-slate-400">NA</span>;
}

function ParameterRow({ p, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const pct = p.max_marks > 0 ? Math.round((p.marks / p.max_marks) * 100) : 0;
  const bar = p.status === "NA" ? "bg-slate-300" : pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <>
      <tr className={`cursor-pointer border-t border-slate-100 transition hover:bg-slate-50 ${open ? "bg-slate-50" : ""}`} onClick={() => setOpen((v) => !v)}>
        <td className="px-4 py-3 text-center">
          <StatusIcon status={p.status} />
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="mono text-xs text-slate-400">{p.id}</span>
            <span className="font-medium text-slate-900">{p.parameter}</span>
            {p.zero_tolerance ? <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700" title="Zero Tolerance Policy">ZTP</span> : null}
          </div>
          <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full ${bar}`} style={{ width: `${p.status === "NA" ? 100 : pct}%` }} />
          </div>
        </td>
        <td className="px-4 py-3 text-center">
          <StatusBadge status={p.status} />
        </td>
        <td className="px-4 py-3 text-center">
          <span className="mono text-sm font-semibold text-slate-900">
            {p.marks}/{p.max_marks}
          </span>
        </td>
        <td className="hidden px-4 py-3 text-sm text-slate-600 md:table-cell">
          <p className={open ? "" : "line-clamp-2"}>{p.reason}</p>
        </td>
        <td className="px-3 py-3 text-right text-xs text-brand-600">{open ? "Hide" : "Evidence"}</td>
      </tr>
      {open ? (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={6} className="px-6 pb-5 pt-1">
            <div className="grid gap-4 md:grid-cols-5">
              <div className="md:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reason</p>
                <p className="mt-1 text-sm text-slate-700">{p.reason}</p>
                <p className="mt-3 text-xs text-slate-400">
                  Evidence source: <span className="font-medium text-slate-600">{SOURCE_LABEL[p.evidence_source] || p.evidence_source || "transcript"}</span>
                </p>
              </div>
              <div className="md:col-span-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Evidence</p>
                {p.evidence && p.evidence.length ? (
                  <ul className="mt-2 space-y-2">
                    {p.evidence.map((e, i) => (
                      <li key={i} className={`rounded-lg border px-3 py-2 text-sm ${e.speaker === "Agent" ? "border-brand-200 bg-brand-50" : e.speaker === "Screen" ? "border-violet-200 bg-violet-50" : "border-slate-200 bg-white"}`}>
                        <div className="mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          <span className={e.speaker === "Agent" ? "text-brand-700" : e.speaker === "Screen" ? "text-violet-700" : ""}>{e.speaker === "Customer" ? "AI Customer" : e.speaker === "Screen" ? "Screen recording" : e.speaker}</span>
                          {e.offset_seconds !== null && e.offset_seconds !== undefined ? <span className="mono normal-case">{formatDuration(e.offset_seconds)}</span> : null}
                          {e.verified === false ? <span className="rounded bg-amber-100 px-1.5 py-0.5 normal-case text-amber-700">{e.speaker === "Screen" ? "not matched to the screen analysis" : "not found verbatim in transcript"}</span> : null}
                          {e.verified ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 normal-case text-emerald-700">verified</span> : null}
                        </div>
                        <p className="text-slate-800">“{e.text}”</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm italic text-slate-400">No evidence cited for this parameter.</p>
                )}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function ScoreCard({ parameters = [], groups = [], expandAll = false }) {
  const order = groups.length ? groups.map((g) => g.group) : Array.from(new Set(parameters.map((p) => p.group || "General")));
  const groupInfo = (name) => groups.find((g) => g.group === name) || null;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-12 px-4 py-3 text-center">Result</th>
            <th className="px-4 py-3">Parameter / Sub parameter</th>
            <th className="w-24 px-4 py-3 text-center">C / NC / NA</th>
            <th className="w-24 px-4 py-3 text-center">Marks</th>
            <th className="hidden px-4 py-3 md:table-cell">Reason</th>
            <th className="w-20 px-3 py-3" />
          </tr>
        </thead>
        <tbody className="bg-white">
          {order.map((name) => {
            const rows = parameters.filter((p) => (p.group || "General") === name);
            if (!rows.length) return null;
            const g = groupInfo(name);
            return [
              <tr key={`g-${name}`} className="border-t border-slate-200 bg-slate-100/80">
                <td colSpan={3} className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-700">
                  {name}
                </td>
                <td className="mono px-4 py-2 text-center text-xs font-bold text-slate-700">{g ? `${g.marks}/${g.applicable_marks}` : ""}</td>
                <td colSpan={2} className="hidden px-4 py-2 text-xs text-slate-500 md:table-cell">
                  {g ? `section max ${g.max_marks}${g.max_marks !== g.applicable_marks ? ` · ${g.max_marks - g.applicable_marks} NA` : ""}` : ""}
                </td>
              </tr>,
              ...rows.map((p) => <ParameterRow key={p.id} p={p} defaultOpen={expandAll} />),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

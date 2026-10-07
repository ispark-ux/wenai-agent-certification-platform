"use client";

import ScoreCard from "@/components/ScoreCard";
import ScreenAnalysis, { VerdictPill } from "@/components/ScreenAnalysis";
import StatusBadge from "@/components/StatusBadge";
import { Card } from "@/components/ui";
import { formatDateTime, formatDuration, percentColor } from "@/lib/format";

function Ring({ percentage, passed }) {
  const pct = Math.max(0, Math.min(100, Number(percentage) || 0));
  const r = 52;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const color = passed ? "#059669" : pct >= 60 ? "#d97706" : "#e11d48";
  return (
    <svg viewBox="0 0 120 120" className="h-36 w-36">
      <circle cx="60" cy="60" r={r} stroke="#e2e8f0" strokeWidth="12" fill="none" />
      <circle cx="60" cy="60" r={r} stroke={color} strokeWidth="12" fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset} transform="rotate(-90 60 60)" />
      <text x="60" y="56" textAnchor="middle" className="fill-slate-900" style={{ fontSize: 24, fontWeight: 800 }}>
        {pct}%
      </text>
      <text x="60" y="76" textAnchor="middle" className="fill-slate-500" style={{ fontSize: 10, fontWeight: 600 }}>
        {passed ? "PASSED" : "NOT PASSED"}
      </text>
    </svg>
  );
}

export default function Result({ result, session }) {
  if (!result) return null;
  const sources = result.evidence_sources || {};
  return (
    <div className="space-y-6">
      {result.ztp_failed ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <p className="font-semibold">Zero Tolerance parameter failed - the certification is marked FAILED.</p>
          <p className="mt-0.5 text-xs">
            {(result.ztp_failures || []).map((z) => `${z.id} ${z.parameter}`).join(", ")} · earned score before ZTP: {result.earned_percentage}%
          </p>
        </div>
      ) : null}
      <Card>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="flex items-center gap-6">
            <Ring percentage={result.percentage} passed={result.passed} />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Certification Result</p>
              <h2 className="mt-1 text-2xl font-bold text-slate-900">{result.agent_name || session?.agent_name || "Agent"}</h2>
              <p className="text-sm text-slate-500">{result.process_name} · {result.scenario_title}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusBadge status={result.passed ? "pass" : "fail"} label={result.passed ? `PASS · ≥ ${result.passing_percentage}%` : result.ztp_failed ? "FAIL · ZTP" : `FAIL · < ${result.passing_percentage}%`} />
                {result.resolution_achieved ? <StatusBadge status="C" label="Issue resolved" /> : <StatusBadge status="NC" label="Issue not resolved" />}
              </div>
            </div>
          </div>
          <dl className="grid flex-1 grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Score</dt>
              <dd className={`text-2xl font-bold ${percentColor(result.percentage)}`}>
                {result.total_marks} <span className="text-base font-semibold text-slate-400">/ {result.applicable_marks}</span>
              </dd>
              <dd className="text-xs text-slate-500">
                applicable marks · {result.maximum_marks} total ({result.na_marks} NA)
              </dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Percentage</dt>
              <dd className={`text-2xl font-bold ${percentColor(result.percentage)}`}>{result.percentage}%</dd>
              <dd className="text-xs text-slate-500">raw {result.raw_percentage}% of {result.maximum_marks}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Parameters</dt>
              <dd className="text-sm font-semibold text-slate-800">
                <span className="text-emerald-600">{result.counts?.C ?? 0} C</span> · <span className="text-rose-600">{result.counts?.NC ?? 0} NC</span> ·{" "}
                <span className="text-slate-500">{result.counts?.NA ?? 0} NA</span>
              </dd>
              <dd className="text-xs text-slate-500">{result.parameters?.length || 0} evaluated</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Process</dt>
              <dd className="font-semibold text-slate-800">{result.process_name}</dd>
              <dd className="text-xs text-slate-500">{result.scenario_title}</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Duration</dt>
              <dd className="font-semibold text-slate-800">{formatDuration(result.duration_seconds)}</dd>
              <dd className="text-xs text-slate-500">{result.transcript_turns} transcript turns</dd>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-400">Evaluated</dt>
              <dd className="font-semibold text-slate-800">{formatDateTime(result.evaluated_at)}</dd>
              <dd className="mono text-xs text-slate-500">{result.model}</dd>
            </div>
          </dl>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 text-xs">
          <span className={`rounded-full px-2.5 py-1 font-medium ${sources.transcript ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>Transcript {sources.transcript ? "analysed" : "empty"}</span>
          <span className={`rounded-full px-2.5 py-1 font-medium ${sources.audio ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>Conversation audio {sources.audio ? "analysed" : "not analysed"}</span>
          <span className={`rounded-full px-2.5 py-1 font-medium ${sources.screen_video_analyzed ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
            Screen recording {sources.screen_video_analyzed ? "analysed by Gemini ✓" : sources.screen_recording_captured ? `captured · not analysed${sources.screen_analysis_error ? ` (${sources.screen_analysis_error})` : ""}` : "not captured"}
          </span>
          {sources.screen_video_analyzed ? (
            <>
              <VerdictPill value={sources.screen_portal_verdict} prefix="Portal: " />
              <VerdictPill value={sources.screen_crm_verdict} prefix="CRM: " />
              <VerdictPill value={sources.screen_consistency} prefix="Screen vs speech: " />
            </>
          ) : null}
        </div>
      </Card>

      {result.groups?.length ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {result.groups.map((g) => (
            <div key={g.group} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.group}</p>
              <p className="mt-1 text-xl font-bold text-slate-900">
                {g.marks}
                <span className="text-sm font-semibold text-slate-400">/{g.applicable_marks}</span>
              </p>
              <p className="text-[11px] text-slate-500">
                max {g.max_marks}
                {g.percentage !== null && g.percentage !== undefined ? ` · ${g.percentage}%` : " · all NA"}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <Card title="Parameter-wise evaluation" subtitle="Click a row to view the auditor's reason and the transcript / screen evidence.">
        <ScoreCard parameters={result.parameters} groups={result.groups || []} expandAll={false} />
      </Card>

      <ScreenAnalysis analysis={result.screen_analysis} error={sources.screen_analysis_error} captured={Boolean(sources.screen_recording_captured)} />

      {true ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Overall feedback" className="lg:col-span-1">
            <p className="text-sm leading-relaxed text-slate-700">{result.overall_feedback || "—"}</p>
          </Card>
          <Card title="Strengths">
            {result.strengths?.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                {result.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">—</p>
            )}
          </Card>
          <Card title="Areas of improvement">
            {result.improvements?.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                {result.improvements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">—</p>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

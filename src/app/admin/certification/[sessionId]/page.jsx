"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import Result from "@/components/Result";
import Transcript from "@/components/Transcript";
import StatusBadge from "@/components/StatusBadge";
import { Alert, Button, Card, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format";

function EmailStatus({ label, status }) {
  if (!status) return <p className="text-sm text-slate-500">{label}: not sent</p>;
  const s = status.status;
  const detail = status.team || status;
  return (
    <div className="text-sm">
      <p className="flex items-center gap-2">
        <span className="text-slate-500">{label}:</span>
        <StatusBadge status={s === "sent" ? "completed" : s === "failed" ? "error" : "created"} label={s} />
        <span className="text-xs text-slate-400">{formatDateTime(status.sent_at || status.attempted_at)}</span>
      </p>
      {detail?.to?.length ? <p className="text-xs text-slate-500">To: {detail.to.join(", ")}{detail.cc?.length ? ` · CC: ${detail.cc.join(", ")}` : ""}</p> : null}
      {status.agent?.to?.length ? <p className="text-xs text-slate-500">Agent copy: {status.agent.to.join(", ")} ({status.agent.status})</p> : null}
      {detail?.error || status.error ? <p className="text-xs text-rose-600">{detail?.error || status.error}</p> : null}
      {detail?.reason ? <p className="text-xs text-amber-600">{detail.reason}</p> : null}
    </div>
  );
}

export default function CertificationDetailPage() {
  const params = useParams();
  const sessionId = params?.sessionId;
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getCertification(sessionId);
      setSession(data.session);
      setResult(data.result || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!session || !["live", "ended", "evaluating", "created"].includes(session.status)) return undefined;
    const t = setInterval(load, session.status === "evaluating" ? 4000 : 8000);
    return () => clearInterval(t);
  }, [session, load]);

  const run = async (kind) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      if (kind === "evaluate") {
        const d = await api.evaluate(sessionId, true);
        if (d.result) {
          setResult(d.result);
          setNotice("Evaluation completed.");
        } else {
          setNotice("Evaluation started - Gemini is analysing the recording. This page refreshes automatically.");
        }
      } else if (kind === "recertify") {
        let d;
        try {
          d = await api.recertify(sessionId, { send_email: true });
        } catch (err) {
          if (err.status === 409 && /Maximum attempts|Cooldown/i.test(err.message) && window.confirm(`${err.message}\n\nOverride and create the recertification anyway?`)) {
            d = await api.recertify(sessionId, { send_email: true, force: true });
          } else throw err;
        }
        setNotice(`Recertification attempt ${d.attempt_no}/${d.max_attempts} ${d.reused ? "(existing unused link reused)" : "created"}: ${window.location.origin}/certification/${d.session.session_id}${d.email?.status === "sent" ? " - emailed to the agent" : ""}`);
        return;
      } else if (kind === "invite") {
        await api.resendInvite(sessionId);
        setNotice("Certification link emailed to the agent.");
      } else if (kind === "result") {
        await api.resendResult(sessionId);
        setNotice("Result email sent.");
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell
      title={session ? session.session_id : "Certification"}
      subtitle={session ? `${session.process_name || ""}${session.scenario_title ? ` · ${session.scenario_title}` : ""}` : ""}
      wide
      actions={
        session ? (
          <>
            <Button variant="secondary" onClick={load}>
              Refresh
            </Button>
            {session.status !== "completed" ? (
              <Button variant="secondary" href={`/certification/${session.session_id}`} target="_blank" rel="noreferrer">
                Open agent link
              </Button>
            ) : null}
            {session.agent_email && session.status !== "completed" ? (
              <Button variant="secondary" onClick={() => run("invite")} loading={busy === "invite"}>
                Resend link email
              </Button>
            ) : null}
            {session.status === "completed" ? (
              <Button variant="secondary" onClick={() => run("result")} loading={busy === "result"}>
                Resend result email
              </Button>
            ) : null}
            {["completed", "error"].includes(session.status) && (session.agent_name || session.agent_email) && !session.result_summary?.passed ? (
              <Button onClick={() => run("recertify")} loading={busy === "recertify"}>
                Recertify agent
              </Button>
            ) : null}
            {session.ended_at && ["completed", "error", "ended"].includes(session.status) ? (
              <Button variant="dark" onClick={() => run("evaluate")} loading={busy === "evaluate"}>
                {session.status === "completed" ? "Re-run evaluation" : "Run evaluation"}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 text-slate-500">
          <Spinner /> Loading…
        </div>
      ) : null}
      {error ? (
        <Alert tone="error" className="mb-4" title="Error">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" className="mb-4">
          {notice}
        </Alert>
      ) : null}

      {session ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={session.status} />
            {session.result_summary ? <StatusBadge status={session.result_summary.passed ? "pass" : "fail"} label={session.result_summary.passed ? "PASSED" : session.result_summary.ztp_failed ? "FAILED - ZTP" : "NOT PASSED"} /> : null}
            {session.ended_reason && session.ended_reason !== "agent_ended" ? <StatusBadge status="NC" label={`Ended: ${session.ended_reason}`} /> : null}
          </div>
          {session.error ? (
            <Alert tone="error" title="Session error">
              {session.error}
            </Alert>
          ) : null}
          {session.status === "evaluating" || busy === "evaluate" ? (
            <Alert tone="info" title="Evaluation in progress">
              {session.evaluation?.stage_label || "Starting…"}
              {session.recording?.screen ? " · Gemini watches the screen recording, listens to the call audio and then scores the rubric (1–5 minutes)." : ""}
            </Alert>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Agent">
              <dl className="space-y-2 text-sm">
                <Row label="Name" value={session.agent_name || "—"} />
                <Row label="Email" value={session.agent_email || "—"} />
                <Row label="Employee ID" value={session.employee_id || "—"} />
                <Row label="Attempt" value={`#${session.attempt_no || 1}${session.attempts > 1 ? ` (${session.attempts} starts on this link)` : ""}`} />
                {session.recertification_of ? <Row label="Recertification of" value={<a className="mono text-xs text-brand-700 hover:underline" href={`/admin/certification/${session.recertification_of}`}>{session.recertification_of}</a>} /> : null}
              </dl>
            </Card>
            <Card title="Session">
              <dl className="space-y-2 text-sm">
                <Row label="Created" value={formatDateTime(session.created_at)} />
                <Row label="Started" value={formatDateTime(session.started_at)} />
                <Row label="Ended" value={formatDateTime(session.ended_at)} />
                <Row label="Duration" value={session.duration_seconds !== null && session.duration_seconds !== undefined ? formatDuration(session.duration_seconds) : "—"} />
                <Row label="Live model" value={<span className="mono text-xs">{session.live?.model || "—"}</span>} />
              </dl>
            </Card>
            <Card title="Emails">
              <div className="space-y-3">
                <EmailStatus label="Certification link" status={session.invite_email} />
                <EmailStatus label="Result" status={session.result_email} />
              </div>
            </Card>
          </div>

          {result ? (
            <Result result={result} session={session} />
          ) : (
            <Card title="Scorecard">
              <p className="text-sm text-slate-500">
                {session.status === "error" ? "Evaluation failed. Fix the configuration (e.g. GEMINI_API_KEY) and click “Run evaluation”." : "The scorecard appears here once the agent ends the certification and the evaluation completes."}
              </p>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Transcript" subtitle="Speech-to-text from Gemini Live (both sides)" padded={false}>
              <Transcript entries={session.transcript || []} autoScroll={false} className="h-[28rem] rounded-b-2xl" emptyText="No transcript was captured for this session." />
            </Card>
            <div className="space-y-6">
              <Card title="Screen recording" subtitle={session.recording?.screen ? `${formatBytes(session.recording.screen.size_bytes)} · ${formatDuration(session.recording.screen.duration_seconds)} · ${session.recording.screen.storage === "supabase" ? "Supabase Storage" : "local file"}` : "Not uploaded"}>
                {session.recording?.screen ? <video controls preload="metadata" className="aspect-video w-full rounded-lg bg-black" src={api.recordingUrl(session.session_id, "screen")} /> : <p className="text-sm text-slate-500">No screen recording uploaded.</p>}
                <p className="mt-2 text-xs text-slate-500">{result?.evidence_sources?.screen_video_analyzed ? "Analysed by Gemini - see the screen recording analysis above for what was observed." : result ? `Not analysed${result.evidence_sources?.screen_analysis_error ? ` (${result.evidence_sources.screen_analysis_error})` : ""} - screen-based parameters were marked NA.` : "Gemini analyses this recording during evaluation to verify portal / CRM actions."}</p>
              </Card>
              <Card title="Conversation audio" subtitle={session.recording?.audio ? `${formatBytes(session.recording.audio.size_bytes)} · ${formatDuration(session.recording.audio.duration_seconds)}` : "Not uploaded"}>
                {session.recording?.audio ? <audio controls preload="metadata" className="w-full" src={api.recordingUrl(session.session_id, "audio")} /> : <p className="text-sm text-slate-500">No conversation audio uploaded.</p>}
                {result?.evidence_sources ? <p className="mt-2 text-xs text-slate-500">{result.evidence_sources.audio ? "This audio was analysed by the evaluator for the voice parameters." : `Audio was not analysed${result.evidence_sources.audio_skipped_reason ? ` (${result.evidence_sources.audio_skipped_reason})` : ""}.`}</p> : null}
              </Card>
            </div>
          </div>
        </div>
      ) : null}
    </AdminShell>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}

"use client";

import { memo, useEffect, useRef, useState } from "react";
import Transcript from "@/components/Transcript";
import { Alert, Button, Card, Modal, Spinner } from "@/components/ui";
import { formatDuration } from "@/lib/format";

function Waveform({ active, level = 0, tone = "customer" }) {
  const color = tone === "customer" ? "bg-brand-500" : "bg-emerald-500";
  const bars = [0.4, 0.7, 1, 0.8, 1, 0.6, 0.45];
  return (
    <div className={`flex h-12 items-center justify-center gap-1 ${active ? "" : "wave-idle"}`} aria-hidden="true">
      {bars.map((b, i) => (
        <span key={i} className={`wave-bar block w-1.5 rounded-full ${color}`} style={{ height: `${Math.max(6, b * 48 * (active ? Math.max(0.35, Math.min(1, level * 2 + 0.3)) : 0.2))}px` }} />
      ))}
    </div>
  );
}

const ScreenThumb = memo(function ScreenThumb({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} muted playsInline className="aspect-video w-full rounded-lg border border-slate-200 bg-black object-contain" />;
});

/**
 * Voice meters poll the audio engine ~12x/sec and keep that state LOCAL, so the
 * rest of the page (transcript, video thumbnails) is not re-rendered on every tick.
 */
const VoiceMeters = memo(function VoiceMeters({ getLevels, phase, customerName, agentName, partialCustomer, lastCustomerLine, partialAgent }) {
  const [levels, setLevels] = useState({ mic: 0, out: 0, aiSpeaking: false, gated: false });
  useEffect(() => {
    if (!getLevels) return undefined;
    const t = setInterval(() => {
      const next = getLevels();
      if (!next) return;
      setLevels((prev) => {
        const q = (v) => Math.round(v * 20) / 20;
        if (prev.aiSpeaking === next.aiSpeaking && prev.gated === next.gated && q(prev.mic) === q(next.mic) && q(prev.out) === q(next.out)) return prev;
        return { mic: q(next.mic), out: q(next.out), aiSpeaking: next.aiSpeaking, gated: next.gated };
      });
    }, 80);
    return () => clearInterval(t);
  }, [getLevels]);

  const connecting = phase === "CONNECTING" || phase === "AI_STARTING";
  const isLive = phase === "LIVE";
  return (
    <Card padded={false}>
      <div className="grid md:grid-cols-2 md:divide-x md:divide-slate-100">
        <div className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">AI Customer · {customerName}</p>
          <div className="mt-3 flex items-center gap-4">
            <div className={`flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold text-white ${levels.aiSpeaking ? "bg-brand-600 ring-4 ring-brand-200" : "bg-slate-400"}`}>{(customerName || "C").charAt(0)}</div>
            <div className="flex-1">
              <Waveform active={levels.aiSpeaking} level={levels.out} tone="customer" />
              <p className="text-center text-xs text-slate-500">{levels.aiSpeaking ? "Speaking…" : phase === "CONNECTING" ? "Connecting to the AI customer…" : phase === "AI_STARTING" ? "Connected. The customer is about to speak…" : phase === "ENDING" ? "Ending the call…" : "Listening"}</p>
            </div>
          </div>
          <p className="mt-4 min-h-[3rem] rounded-xl bg-slate-50 px-4 py-3 text-sm italic text-slate-700">{partialCustomer || lastCustomerLine || (connecting ? "Waiting for the customer to speak…" : "")}</p>
        </div>
        <div className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">You · {agentName}</p>
          <div className="mt-3 flex items-center gap-4">
            <div className={`flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold text-white ${levels.mic > 0.06 ? "bg-emerald-600 ring-4 ring-emerald-200" : "bg-slate-400"}`}>{(agentName || "A").charAt(0).toUpperCase()}</div>
            <div className="flex-1">
              <Waveform active={levels.mic > 0.04} level={levels.mic} tone="agent" />
              <p className="text-center text-xs text-slate-500">{!isLive ? "Microphone opens when the customer speaks" : levels.gated ? "Customer is speaking - please wait" : "Microphone live - your turn"}</p>
            </div>
          </div>
          <p className="mt-4 min-h-[3rem] rounded-xl bg-slate-50 px-4 py-3 text-sm italic text-slate-700">{partialAgent || "Speak naturally, exactly as on a real call."}</p>
        </div>
      </div>
    </Card>
  );
});

export default function LiveCertification({
  phase,
  process,
  agentName,
  elapsedSeconds,
  transcript,
  partialCustomer,
  partialAgent,
  lastCustomerLine,
  getLevels,
  screenStream,
  screenActive,
  recording,
  logs,
  connectionIssue,
  onEnd,
  onReconnect,
  onCancel,
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const isLive = phase === "LIVE";
  const connecting = phase === "CONNECTING" || phase === "AI_STARTING";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-900 px-5 py-4 text-white shadow-md">
        <div>
          <h2 className="text-lg font-bold">
            {process?.process_name} <span className="font-normal text-slate-300">· {process?.scenario?.title}</span>
          </h2>
          <p className="text-xs text-slate-400">
            {process?.language} · AI customer: {process?.customer_name}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Duration</p>
            <p className="mono text-2xl font-bold">{formatDuration(elapsedSeconds)}</p>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${isLive ? "bg-rose-600" : "bg-slate-700"}`}>
            {isLive ? <span className="live-dot h-2 w-2 rounded-full bg-white" /> : <Spinner className="h-3 w-3" />}
            {isLive ? "LIVE" : phase === "ENDING" ? "ENDING" : "CONNECTING"}
          </span>
        </div>
      </div>

      {connectionIssue ? (
        <Alert
          tone="error"
          title="AI connection problem"
          actions={
            <>
              <Button size="sm" onClick={onReconnect}>
                Reconnect
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirmOpen(true)}>
                End certification
              </Button>
            </>
          }
        >
          {connectionIssue}
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <VoiceMeters getLevels={getLevels} phase={phase} customerName={process?.customer_name} agentName={agentName} partialCustomer={partialCustomer} lastCustomerLine={lastCustomerLine} partialAgent={partialAgent} />
          <Card title="Live transcript" padded={false}>
            <Transcript entries={transcript} partialCustomer={partialCustomer} partialAgent={partialAgent} className="h-[20rem] rounded-b-2xl" />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Screen recording">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium text-slate-800">
                <span className={`h-2.5 w-2.5 rounded-full ${recording ? "live-dot bg-rose-500" : "bg-slate-300"}`} />
                {recording ? "Recording" : "Not recording"}
              </span>
              <span className={`text-xs font-semibold ${screenActive ? "text-emerald-600" : "text-rose-600"}`}>{screenActive ? "Sharing active ✓" : "Sharing stopped ✕"}</span>
            </div>
            {screenStream && screenActive ? <ScreenThumb stream={screenStream} /> : <div className="aspect-video rounded-lg bg-slate-200" />}
          </Card>

          {connecting ? (
            <Button variant="secondary" className="w-full" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="danger" size="lg" className="w-full" onClick={() => setConfirmOpen(true)} disabled={phase === "ENDING"}>
              END CERTIFICATION
            </Button>
          )}

          <div className="rounded-xl border border-slate-200 bg-white">
            <button type="button" className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium text-slate-500" onClick={() => setShowLog((v) => !v)}>
              <span>Connection log</span>
              <span className="text-brand-600">{showLog ? "Hide" : "Show"}</span>
            </button>
            {showLog ? (
              <ul className="scroll-thin mono max-h-48 space-y-1 overflow-y-auto border-t border-slate-100 px-4 py-2 text-[11px] leading-snug">
                {logs.slice(-60).map((l, i) => (
                  <li key={i} className={l.level === "error" ? "text-rose-600" : l.level === "warn" ? "text-amber-600" : "text-slate-600"}>
                    <span className="text-slate-400">{new Date(l.timestamp).toLocaleTimeString()} </span>
                    {l.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        title="Are you sure you want to end certification?"
        tone="danger"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Continue Certification
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmOpen(false);
                onEnd("agent_ended");
              }}
            >
              End Certification
            </Button>
          </>
        }
      >
        The call stops immediately. Your transcript and recordings are uploaded and Gemini evaluates the call. Make sure you have closed the call properly with the customer.
      </Modal>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Header from "@/components/Header";
import LiveCertification from "@/components/LiveCertification";
import Result from "@/components/Result";
import StatusBadge from "@/components/StatusBadge";
import { Alert, Button, Card, Modal, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { GeminiLiveClient } from "@/lib/live/gemini-live-client";
import { AudioEngine } from "@/lib/live/audio-engine";
import { ScreenRecorder, requestScreenStream, requestMicrophoneStream, describeMediaError, describeScreenSurface, stopStream } from "@/lib/live/screen-recorder";
import { uploadRecordingResilient } from "@/lib/live/uploader";

/**
 * Single-page certification:
 *   READY → (START click) SCREEN_PERMISSION → MIC_PERMISSION → CONNECTING → AI_STARTING → LIVE
 *   → (END click) ENDING → UPLOADING → EVALUATING → COMPLETED        (ERROR at any point, retryable)
 */
const LIVE_PHASES = ["CONNECTING", "AI_STARTING", "LIVE", "ENDING"];
const AGENT_COMMIT_SILENCE_MS = 2500;
const AI_START_RETRY_MS = 8000;
const AI_START_TIMEOUT_MS = 25000;

export default function CertificationPage() {
  const params = useParams();
  const sessionId = params?.sessionId;

  const [phase, setPhaseState] = useState("LOADING");
  const [session, setSession] = useState(null);
  const [process, setProcess] = useState(null);
  const [result, setResult] = useState(null);
  const [agentName, setAgentName] = useState("");
  const [error, setError] = useState(null);
  const [retryAction, setRetryAction] = useState(null); // null | "upload" | "evaluate"
  const [connectionIssue, setConnectionIssue] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [screenActive, setScreenActive] = useState(false);
  const [screenStopped, setScreenStopped] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [partialCustomer, setPartialCustomer] = useState("");
  const [partialAgent, setPartialAgent] = useState("");
  const [lastCustomerLine, setLastCustomerLine] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState("");

  const phaseRef = useRef("LOADING");
  const liveRef = useRef(null);
  const audioRef = useRef(null);
  const screenRecRef = useRef(null);
  const screenStreamRef = useRef(null);
  const micStreamRef = useRef(null);
  const transcriptRef = useRef([]);
  const partialRef = useRef({ customer: "", agent: "", customerStart: null, agentStart: null });
  const startedAtRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveRef = useRef(null);
  const agentCommitTimerRef = useRef(null);
  const aiStartTimersRef = useRef([]);
  const endingRef = useRef(false);
  const logsRef = useRef([]);
  const artifactsRef = useRef(null);
  const processRef = useRef(null);

  const setPhase = useCallback((p) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  // Stable getter polled by the voice meters (keeps 10 Hz level updates out of page state).
  const getLevels = useCallback(() => (audioRef.current ? audioRef.current.getLevels() : null), []);

  const addLog = useCallback((entry) => {
    const item = { timestamp: entry.timestamp || new Date().toISOString(), level: entry.level || "info", message: entry.message };
    logsRef.current = [...logsRef.current.slice(-299), item];
    setLogs(logsRef.current);
  }, []);
  const log = useCallback((level, message) => addLog({ level, message }), [addLog]);

  // ---------------------------------------------------------------- load
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getCertification(sessionId);
        if (cancelled) return;
        setSession(data.session);
        if (data.session.agent_name) setAgentName(data.session.agent_name);
        if (data.session.process_id) {
          const p = await api.getProcess(data.session.process_id);
          if (cancelled) return;
          setProcess(p.process);
          processRef.current = p.process;
        }
        if (data.session.status === "completed" && data.result) {
          setResult(data.result);
          setPhase("COMPLETED");
          return;
        }
        if (data.session.ended_at && ["ended", "evaluating", "error"].includes(data.session.status)) {
          setError(data.session.error || "The call ended but the evaluation did not complete.");
          setRetryAction("evaluate");
          setPhase("ERROR");
          return;
        }
        setPhase("READY");
      } catch (err) {
        if (cancelled) return;
        setError(err.status === 404 ? "This certification link is invalid." : err.message);
        setPhase("NOT_FOUND");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, setPhase]);

  // Warn before leaving mid-call; clean everything up on unmount.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (LIVE_PHASES.includes(phaseRef.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearTimers();
      try {
        liveRef.current?.close("page unmounted");
        audioRef.current?.destroy();
        stopStream(screenStreamRef.current);
        stopStream(micStreamRef.current);
      } catch {
        /* ignore */
      }
    };
  }, []);

  function clearTimers() {
    [timerRef, autosaveRef].forEach((r) => {
      if (r.current) clearInterval(r.current);
      r.current = null;
    });
    if (agentCommitTimerRef.current) clearTimeout(agentCommitTimerRef.current);
    agentCommitTimerRef.current = null;
    aiStartTimersRef.current.forEach((t) => clearTimeout(t));
    aiStartTimersRef.current = [];
  }

  // ---------------------------------------------------------------- transcript
  const offsetFor = (iso) => {
    if (!startedAtRef.current) return 0;
    return Math.max(0, Math.round(((iso ? new Date(iso).getTime() : Date.now()) - startedAtRef.current) / 1000));
  };

  const pushTranscript = (speaker, text, startIso, interrupted = false) => {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    transcriptRef.current = [...transcriptRef.current, { speaker, text: clean, timestamp: startIso || new Date().toISOString(), offset_seconds: offsetFor(startIso), interrupted }];
    setTranscript(transcriptRef.current);
    if (speaker === "Customer") setLastCustomerLine(clean);
  };

  const commitAgent = () => {
    if (agentCommitTimerRef.current) clearTimeout(agentCommitTimerRef.current);
    agentCommitTimerRef.current = null;
    const p = partialRef.current;
    if (p.agent.trim()) pushTranscript("Agent", p.agent, p.agentStart);
    p.agent = "";
    p.agentStart = null;
    setPartialAgent("");
  };

  const commitCustomer = (interrupted = false) => {
    const p = partialRef.current;
    if (p.customer.trim()) pushTranscript("Customer", p.customer, p.customerStart, interrupted);
    p.customer = "";
    p.customerStart = null;
    setPartialCustomer("");
  };

  const onOutputTranscription = (text) => {
    const p = partialRef.current;
    if (p.agent.trim()) commitAgent(); // agent finished, customer is replying
    if (!p.customerStart) p.customerStart = new Date().toISOString();
    p.customer += text;
    setPartialCustomer(p.customer);
  };

  const onInputTranscription = (text) => {
    const p = partialRef.current;
    if (!p.agentStart) p.agentStart = new Date().toISOString();
    p.agent += text;
    setPartialAgent(p.agent);
    if (agentCommitTimerRef.current) clearTimeout(agentCommitTimerRef.current);
    agentCommitTimerRef.current = setTimeout(commitAgent, AGENT_COMMIT_SILENCE_MS);
  };

  // ---------------------------------------------------------------- live helpers
  const goLive = () => {
    if (phaseRef.current !== "AI_STARTING") return;
    aiStartTimersRef.current.forEach((t) => clearTimeout(t));
    aiStartTimersRef.current = [];
    startedAtRef.current = Date.now();
    setElapsed(0);
    setPhase("LIVE");
    audioRef.current?.setMicEnabled(true);
    log("info", "AI customer started speaking - certification is LIVE");
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    autosaveRef.current = setInterval(() => {
      if (transcriptRef.current.length) api.saveTranscript(sessionId, transcriptRef.current).catch((err) => log("warn", `Transcript autosave failed: ${err.message}`));
    }, 15000);
  };

  const buildLiveClient = () =>
    new GeminiLiveClient({
      onLog: addLog,
      onAudio: (b64, mime) => {
        audioRef.current?.playPcmChunk(b64, mime);
        if (phaseRef.current === "AI_STARTING") goLive();
      },
      onOutputTranscription,
      onInputTranscription,
      onTurnComplete: () => commitCustomer(false),
      onInterrupted: () => {
        audioRef.current?.interruptPlayback();
        commitCustomer(true);
      },
      onError: (err) => {
        if (LIVE_PHASES.includes(phaseRef.current)) setConnectionIssue(err.message);
      },
      onClose: (info) => {
        if (info.intentional || endingRef.current) return;
        if (["LIVE", "AI_STARTING"].includes(phaseRef.current)) {
          audioRef.current?.setMicEnabled(false);
          setConnectionIssue(`The AI connection closed unexpectedly (code ${info.code}${info.reason ? `: ${info.reason}` : ""}).${info.hint ? ` ${info.hint}.` : ""} Reconnect to continue, or end the certification now.`);
        }
      },
    });

  const connectLive = async (tokenInfo, kickoffText) => {
    const client = buildLiveClient();
    liveRef.current = client;
    await client.connect({ wsUrl: tokenInfo.ws_url, token: tokenInfo.token, setup: tokenInfo.setup, setupTimeoutMs: (tokenInfo.setup_timeout_seconds || 15) * 1000, connectTimeoutMs: 10000 });
    client.sendText(kickoffText);
  };

  const cleanupMedia = async () => {
    clearTimers();
    try {
      liveRef.current?.close("cleanup");
    } catch {
      /* ignore */
    }
    try {
      await screenRecRef.current?.stop("aborted");
    } catch {
      /* ignore */
    }
    try {
      await audioRef.current?.stopConversationRecorder();
      await audioRef.current?.destroy();
    } catch {
      /* ignore */
    }
    stopStream(screenStreamRef.current);
    stopStream(micStreamRef.current);
    liveRef.current = null;
    screenRecRef.current = null;
    audioRef.current = null;
    screenStreamRef.current = null;
    micStreamRef.current = null;
    setScreenStream(null);
    setScreenActive(false);
    setRecording(false);
  };

  const failStart = async (message) => {
    if (phaseRef.current === "ERROR" || endingRef.current) return;
    log("error", message);
    await cleanupMedia();
    setError(message);
    setRetryAction(null);
    setPhase("ERROR");
  };

  const handleScreenEnded = () => {
    setScreenActive(false);
    log("warn", "Screen sharing stopped by the user/browser");
    const p = phaseRef.current;
    if (["LIVE", "AI_STARTING", "CONNECTING"].includes(p)) {
      // Never silently continue: mute the mic, drop the AI connection and force a safe end.
      audioRef.current?.setMicEnabled(false);
      liveRef.current?.close("screen share stopped");
      setScreenStopped(true);
    }
  };

  // ---------------------------------------------------------------- START
  const startCertification = async () => {
    if (!["READY", "ERROR"].includes(phaseRef.current)) return;
    endingRef.current = false;
    transcriptRef.current = [];
    partialRef.current = { customer: "", agent: "", customerStart: null, agentStart: null };
    setTranscript([]);
    setPartialAgent("");
    setPartialCustomer("");
    setLastCustomerLine("");
    setError(null);
    setRetryAction(null);
    setConnectionIssue(null);
    setScreenStopped(false);
    setElapsed(0);

    try {
      // 1. Screen recording permission (real browser picker)
      setPhase("SCREEN_PERMISSION");
      let screen;
      try {
        screen = await requestScreenStream();
      } catch (err) {
        throw new Error(`${describeMediaError(err, "screen")} Screen recording is mandatory for certification - click START again and choose "Entire Screen".`);
      }
      screenStreamRef.current = screen;
      setScreenStream(screen);
      setScreenActive(true);
      const track = screen.getVideoTracks()[0];
      if (track) track.onended = handleScreenEnded;
      log("info", `Screen sharing enabled (${describeScreenSurface(screen)})`);

      // 2. Microphone permission
      setPhase("MIC_PERMISSION");
      let mic;
      try {
        mic = await requestMicrophoneStream();
      } catch (err) {
        throw new Error(describeMediaError(err, "mic"));
      }
      micStreamRef.current = mic;
      log("info", "Microphone enabled");
      if (!track || track.readyState !== "live") throw new Error("Screen sharing was stopped before the call started. Please start again.");

      // 3. Mark the session as started on the server
      setPhase("CONNECTING");
      const { session: s } = await api.startCertification(sessionId, { agent_name: agentName.trim() || "Agent" });
      setSession(s);

      // 4. Audio engine + recorders
      const engine = new AudioEngine({ onMicChunk: (b64, rate) => liveRef.current?.sendAudioChunk(b64, rate), onLog: addLog, halfDuplex: true });
      audioRef.current = engine;
      await engine.init(mic);
      const rec = new ScreenRecorder(screen, { onLog: addLog });
      rec.start();
      screenRecRef.current = rec;
      setRecording(true);
      engine.startConversationRecorder();

      // 5. Ephemeral token → Gemini Live → customer speaks first
      log("info", "Requesting Gemini Live token");
      const tokenInfo = await api.getLiveToken(sessionId);
      log("info", `Live token received (model ${tokenInfo.model})`);
      engine.setHalfDuplex(tokenInfo.half_duplex !== false);
      await connectLive(tokenInfo, tokenInfo.kickoff_text);
      setPhase("AI_STARTING");

      // 6. Watchdogs: never stay stuck waiting for the first utterance
      aiStartTimersRef.current.push(
        setTimeout(() => {
          if (phaseRef.current === "AI_STARTING" && liveRef.current?.isOpen) {
            log("warn", "No audio from the AI customer yet - re-sending the start instruction");
            liveRef.current.sendText(tokenInfo.kickoff_text);
          }
        }, AI_START_RETRY_MS)
      );
      aiStartTimersRef.current.push(
        setTimeout(() => {
          if (phaseRef.current === "AI_STARTING") failStart("AI trainer connected but did not start speaking within 25 seconds. Please try again.");
        }, AI_START_TIMEOUT_MS)
      );
    } catch (err) {
      await failStart(err.message || String(err));
    }
  };

  const cancelStart = () => failStart("Cancelled.");

  const reconnectLive = async () => {
    setConnectionIssue(null);
    log("info", "Reconnecting to the AI customer…");
    try {
      liveRef.current?.close("reconnecting");
      await audioRef.current?.resume();
      const tokenInfo = await api.getLiveToken(sessionId);
      const name = processRef.current?.customer_name || "the customer";
      const recent = transcriptRef.current.slice(-12).map((t) => `${t.speaker}: ${t.text}`).join("\n");
      const text = `[SYSTEM - CALL RECONNECTED] The phone line dropped for a moment and is now reconnected. You are still ${name}, the same customer, in the same call. Conversation so far:\n${recent || "(the call had just started)"}\n\nContinue naturally from where it stopped. Do NOT repeat the greeting or restart the conversation. Say one short natural line like "Hello, haan ji, line kat gayi thi" and then wait for the agent.`;
      await connectLive(tokenInfo, text);
      audioRef.current?.setMicEnabled(true);
      if (phaseRef.current === "AI_STARTING") goLive();
    } catch (err) {
      setConnectionIssue(`Reconnect failed: ${err.message}`);
    }
  };

  // ---------------------------------------------------------------- END → upload → evaluate
  const EVAL_POLL_MS = 3000;
  const EVAL_TIMEOUT_MS = 25 * 60 * 1000;

  const waitForEvaluation = async () => {
    const started = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, EVAL_POLL_MS));
      let data;
      try {
        data = await api.getCertification(sessionId);
      } catch (err) {
        log("warn", `Status poll failed: ${err.message}`);
        continue;
      }
      const s = data.session;
      if (s.status === "completed" && data.result) return data;
      if (s.status === "error") throw new Error(s.error || "Evaluation failed.");
      const label = s.evaluation?.stage_label || "Evaluating…";
      const mins = Math.floor((Date.now() - started) / 60000);
      setProgress(`${label}${mins >= 1 ? ` · ${mins} min elapsed` : ""}`);
      if (Date.now() - started > EVAL_TIMEOUT_MS) throw new Error("The evaluation is taking longer than expected. Please retry.");
    }
  };

  const runEvaluation = async () => {
    setPhase("EVALUATING");
    setError(null);
    setRetryAction(null);
    setProgress("Starting the evaluation…");
    try {
      const kick = await api.evaluate(sessionId);
      let data = kick;
      if (!kick.result) data = await waitForEvaluation();
      setResult(data.result);
      if (data.session) setSession(data.session);
      setPhase("COMPLETED");
    } catch (err) {
      setError(`Evaluation failed: ${err.message}`);
      setRetryAction("evaluate");
      setPhase("ERROR");
    }
  };

  const uploadAndFinalize = async () => {
    const art = artifactsRef.current;
    if (!art) return runEvaluation();
    setPhase("UPLOADING");
    setError(null);
    setRetryAction(null);
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    try {
      setProgress("Saving transcript…");
      await api.saveTranscript(sessionId, transcriptRef.current, true);
      if (art.screenResult && art.screenResult.blob.size > 0 && !art.screenUploaded) {
        const size = mb(art.screenResult.blob.size);
        await uploadRecordingResilient({
          sessionId,
          kind: "screen",
          blob: art.screenResult.blob,
          meta: art.screenResult,
          log,
          onProgress: (f, mode) => setProgress(`Uploading screen recording (${size} MB) · ${Math.round(f * 100)}%${mode === "direct" ? " · direct to storage" : ""}`),
        });
        art.screenUploaded = true;
      } else if (!art.screenResult || art.screenResult.blob.size === 0) {
        log("warn", "No screen recording data was captured");
      }
      if (art.audioResult && art.audioResult.blob.size > 0 && !art.audioUploaded) {
        const size = mb(art.audioResult.blob.size);
        await uploadRecordingResilient({
          sessionId,
          kind: "audio",
          blob: art.audioResult.blob,
          meta: art.audioResult,
          log,
          onProgress: (f) => setProgress(`Uploading conversation audio (${size} MB) · ${Math.round(f * 100)}%`),
        });
        art.audioUploaded = true;
      }
      setProgress("Finalising…");
      await api.endCertification(sessionId, {
        started_at: art.startedAtIso,
        ended_at: art.endedAtIso,
        duration_seconds: art.durationSeconds,
        ended_reason: art.reason,
        transcript: transcriptRef.current,
        client_log: logsRef.current.slice(-200),
      });
      artifactsRef.current = null;
    } catch (err) {
      log("error", `Upload failed: ${err.message}`);
      setError(`Upload failed: ${err.message}`);
      setRetryAction("upload");
      setPhase("ERROR");
      return;
    }
    await runEvaluation();
  };

  const endCertification = async (reason = "agent_ended") => {
    if (endingRef.current) return;
    endingRef.current = true;
    setScreenStopped(false);
    setConnectionIssue(null);
    setPhase("ENDING");
    const endedAtIso = new Date().toISOString();
    clearTimers();
    audioRef.current?.setMicEnabled(false);
    commitAgent();
    commitCustomer(false);
    try {
      liveRef.current?.sendAudioStreamEnd();
    } catch {
      /* ignore */
    }
    liveRef.current?.close("certification ended");
    const startedAtIso = startedAtRef.current ? new Date(startedAtRef.current).toISOString() : null;
    const durationSeconds = startedAtRef.current ? Math.max(0, Math.round((Date.parse(endedAtIso) - startedAtRef.current) / 1000)) : 0;

    let screenResult = null;
    let audioResult = null;
    try {
      screenResult = await screenRecRef.current?.stop(reason);
    } catch (err) {
      log("warn", `Screen recorder stop failed: ${err.message}`);
    }
    try {
      audioResult = await audioRef.current?.stopConversationRecorder();
    } catch (err) {
      log("warn", `Audio recorder stop failed: ${err.message}`);
    }
    setRecording(false);
    stopStream(screenStreamRef.current);
    stopStream(micStreamRef.current);
    setScreenActive(false);
    try {
      await audioRef.current?.destroy();
    } catch {
      /* ignore */
    }
    artifactsRef.current = { screenResult, audioResult, endedAtIso, startedAtIso, durationSeconds, reason };
    await uploadAndFinalize();
  };

  // ---------------------------------------------------------------- render
  const headerRight = (
    <div className="flex items-center gap-3">
      <span className="mono hidden text-xs font-semibold text-slate-600 sm:block">{sessionId}</span>
      <StatusBadge status={phase === "LIVE" ? "live" : phase === "COMPLETED" ? "completed" : phase === "ERROR" ? "error" : "created"} label={phase.replace(/_/g, " ")} />
    </div>
  );

  const renderStart = () => {
    const requesting = phase === "SCREEN_PERMISSION" || phase === "MIC_PERMISSION";
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">{process?.process_name} certification</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{process?.scenario?.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Language: {process?.language} · {process?.rubric_parameter_count} quality parameters · up to {process?.live_settings?.max_duration_minutes} minutes
          </p>

          <div className="mt-5 rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm text-brand-900">
            <p className="font-semibold">You will interact with an AI customer. Please behave exactly as you would in a real customer call.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>The customer speaks first. Listen and respond naturally in {process?.language}.</li>
              <li>Your screen and the call are recorded. When asked, share your <strong>entire screen</strong> and allow the microphone.</li>
              <li>Use your portal / CRM as you normally would. Click END CERTIFICATION only after closing the call properly.</li>
            </ul>
          </div>

          <label className="mt-5 block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Your name</span>
            <input className={inputClass} value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Saurabh" disabled={requesting} />
            {session?.agent_email ? <span className="mt-1 block text-xs text-slate-500">Invited: {session.agent_email}</span> : null}
          </label>

          {error ? (
            <Alert tone="error" className="mt-4" title="Could not start">
              {error}
            </Alert>
          ) : null}

          <div className="mt-6 flex flex-col items-center gap-3">
            <Button size="xl" className="w-full sm:w-auto" onClick={startCertification} loading={requesting} disabled={requesting}>
              {phase === "SCREEN_PERMISSION" ? "Waiting for screen sharing permission…" : phase === "MIC_PERMISSION" ? "Waiting for microphone permission…" : phase === "ERROR" ? "TRY AGAIN" : "START CERTIFICATION"}
            </Button>
            <p className="text-xs text-slate-500">Works on desktop Chrome / Edge over HTTPS or localhost. Use a headset.</p>
          </div>
        </Card>
      </div>
    );
  };

  const renderBody = () => {
    switch (phase) {
      case "LOADING":
        return (
          <div className="flex items-center gap-2 py-20 text-slate-500">
            <Spinner /> Loading certification…
          </div>
        );
      case "NOT_FOUND":
        return (
          <Card title="Certification link not found">
            <Alert tone="error">{error}</Alert>
          </Card>
        );
      case "READY":
      case "SCREEN_PERMISSION":
      case "MIC_PERMISSION":
        return renderStart();
      case "CONNECTING":
      case "AI_STARTING":
      case "LIVE":
      case "ENDING":
        return (
          <LiveCertification
            phase={phase}
            process={process}
            agentName={session?.agent_name || agentName || "Agent"}
            elapsedSeconds={elapsed}
            transcript={transcript}
            partialCustomer={partialCustomer}
            partialAgent={partialAgent}
            lastCustomerLine={lastCustomerLine}
            getLevels={getLevels}
            screenStream={screenStream}
            screenActive={screenActive}
            recording={recording}
            logs={logs}
            connectionIssue={connectionIssue}
            onEnd={endCertification}
            onReconnect={reconnectLive}
            onCancel={cancelStart}
          />
        );
      case "UPLOADING":
      case "EVALUATING":
        return (
          <Card className="mx-auto max-w-xl">
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <Spinner className="h-10 w-10 text-brand-600" />
              <h3 className="text-xl font-bold text-slate-900">{phase === "UPLOADING" ? "Uploading recording & transcript" : "Gemini is evaluating your call"}</h3>
              <p className="text-sm text-slate-600">{progress}</p>
              <p className="text-xs text-slate-400">{phase === "UPLOADING" ? "Keep this tab open." : "Gemini watches the screen recording, listens to the call and scores every parameter. This can take 1–5 minutes depending on the call length. You may keep this tab open or come back to this link later."}</p>
            </div>
          </Card>
        );
      case "COMPLETED":
        return (
          <div className="space-y-5">
            <Alert tone="success" title="Certification completed">
              Thank you{session?.agent_name ? `, ${session.agent_name}` : ""}. Your call has been evaluated - the scorecard is below.
              {session?.result_email?.status === "sent" ? " A copy of this result has been emailed." : ""}
            </Alert>
            <Result result={result} session={session} />
          </div>
        );
      case "ERROR":
        if (!retryAction) return renderStart();
        return (
          <Card title="Something went wrong" className="mx-auto max-w-xl">
            <Alert tone="error">{error}</Alert>
            <div className="mt-4 flex flex-wrap gap-2">
              {retryAction === "evaluate" ? <Button onClick={runEvaluation}>Retry evaluation</Button> : null}
              {retryAction === "upload" ? <Button onClick={uploadAndFinalize}>Retry upload &amp; evaluation</Button> : null}
              {retryAction === "upload" ? <span className="self-center text-xs text-slate-500">Your recording is still in this tab - do not close it before retrying.</span> : null}
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </Card>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen">
      <Header subtitle={process ? `${process.process_name} · ${process.scenario?.title}` : "Agent certification"} right={headerRight} />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{renderBody()}</main>

      <Modal
        open={screenStopped}
        title="Screen sharing stopped. Certification cannot continue."
        tone="danger"
        footer={
          <Button variant="danger" onClick={() => endCertification("screen_share_stopped")}>
            End &amp; submit certification
          </Button>
        }
      >
        Screen recording is mandatory. The AI conversation has been paused; the call will now be submitted with the evidence captured so far.
      </Modal>
    </div>
  );
}

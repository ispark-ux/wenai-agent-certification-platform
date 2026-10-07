import { db } from "./db";
import { getProcess } from "./processes";
import { getSession, updateSession, sanitizeTranscript, SESSION_STATUS } from "./sessions";
import { evaluateSession } from "./evaluation";
import { analyzeScreenRecording } from "./screen-analysis";
import { describeGeminiError, getGeminiConfig } from "./gemini";
import { sendResultForSession } from "./certifications";
import { nowIso } from "./storage";

/**
 * Background evaluation pipeline (runs after the HTTP response is sent):
 *   preparing → uploading_video → processing_video → analysing_screen → scoring → emailing → completed
 * Progress is persisted in session.evaluation.stage so the browser can poll it.
 */
export const EVALUATION_STAGES = {
  preparing: "Preparing transcript and recordings",
  uploading_video: "Uploading the screen recording to Gemini",
  processing_video: "Gemini is processing the screen recording",
  analysing_screen: "Gemini is watching the screen recording (portal / CRM check)",
  uploading_audio: "Uploading the conversation audio to Gemini",
  scoring: "Gemini is scoring the call against the rubric",
  emailing: "Sending the result email",
  completed: "Completed",
};

const STALE_AFTER_MS = 20 * 60 * 1000;
const running = new Map(); // session_id -> Promise (per server process)

export function isEvaluationRunning(session) {
  if (running.has(session.session_id)) return true;
  if (session.status !== SESSION_STATUS.EVALUATING) return false;
  const started = session.evaluation?.started_at ? new Date(session.evaluation.started_at).getTime() : 0;
  return started > 0 && Date.now() - started < STALE_AFTER_MS;
}

async function setStage(sessionId, stage, extra = {}) {
  await updateSession(sessionId, (s) => {
    s.evaluation = { ...(s.evaluation || {}), stage, stage_label: EVALUATION_STAGES[stage] || stage, stage_at: nowIso(), ...extra };
    return s;
  });
}

/** Kicks off the pipeline (idempotent per process). Returns immediately. */
export function startEvaluationJob(sessionId, baseUrl) {
  if (running.has(sessionId)) return running.get(sessionId);
  const job = runEvaluationJob(sessionId, baseUrl)
    .catch((err) => console.error(`[evaluation-job] ${sessionId} failed:`, err?.message || err))
    .finally(() => running.delete(sessionId));
  running.set(sessionId, job);
  return job;
}

export async function markEvaluationStarted(sessionId) {
  const cfg = getGeminiConfig();
  await updateSession(sessionId, (s) => {
    s.status = SESSION_STATUS.EVALUATING;
    s.error = null;
    s.evaluation = { status: "running", started_at: nowIso(), completed_at: null, error: null, model: cfg.evaluationModel, stage: "preparing", stage_label: EVALUATION_STAGES.preparing, stage_at: nowIso() };
    return s;
  });
}

export async function runEvaluationJob(sessionId, baseUrl) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const process_ = await getProcess(session.process_id);
  if (!process_) throw new Error(`Process '${session.process_id}' not found`);

  const transcript = sanitizeTranscript(session.transcript);
  const recordingInfo = {
    screen: session.recording?.screen || null,
    audio: session.recording?.audio || null,
    metadata: { started_at: session.started_at, ended_at: session.ended_at, duration_seconds: session.duration_seconds },
    screen_video_analyzed: false,
    screen_analysis_error: null,
  };
  const onStage = (stage) => setStage(sessionId, stage).catch(() => {});

  try {
    // ---- Stage 1: Gemini watches the screen recording
    let screenAnalysis = null;
    const screenEnabled = process_.screen_analysis?.enabled !== false;
    if (recordingInfo.screen && screenEnabled) {
      try {
        const video = await db.getRecordingBuffer(sessionId, "screen");
        if (!video || video.length < 10 * 1024) {
          recordingInfo.screen_analysis_error = "screen recording file is empty or too small";
        } else {
          screenAnalysis = await analyzeScreenRecording({ process: process_, session, transcript, videoBuffer: video, mimeType: recordingInfo.screen.mime_type || "video/webm", onStage });
          recordingInfo.screen_video_analyzed = true;
          await setStage(sessionId, "scoring", { screen_summary: { portal: screenAnalysis.portal_verdict, crm: screenAnalysis.crm_verdict, consistency: screenAnalysis.cross_check?.consistency, checks_pass: screenAnalysis.counts.checks_pass, checks_fail: screenAnalysis.counts.checks_fail, readable: screenAnalysis.video_readable } });
        }
      } catch (err) {
        const message = describeGeminiError(err);
        console.error(`[evaluation-job] screen analysis failed for ${sessionId}:`, message);
        recordingInfo.screen_analysis_error = message.slice(0, 300);
      }
    } else if (recordingInfo.screen && !screenEnabled) {
      recordingInfo.screen_analysis_error = "screen analysis disabled for this process";
    }

    // ---- Stage 2: scorecard (transcript + audio + screen analysis)
    const evaluation = await evaluateSession({ session, process: process_, transcript, recordingInfo, screenAnalysis, onStage });
    const result = {
      session_id: sessionId,
      process_id: process_.process_id,
      process_name: process_.process_name,
      scenario_title: process_.scenario?.title || null,
      language: process_.language || null,
      agent_id: session.agent_id || null,
      agent_name: session.agent_name,
      agent_email: session.agent_email || null,
      employee_id: session.employee_id || null,
      started_at: session.started_at,
      ended_at: session.ended_at,
      duration_seconds: session.duration_seconds,
      ended_reason: session.ended_reason,
      evaluated_at: nowIso(),
      transcript_turns: transcript.length,
      ...evaluation,
    };
    await db.saveResult(result);

    await updateSession(sessionId, (s) => {
      s.status = SESSION_STATUS.COMPLETED;
      s.error = null;
      s.result_summary = {
        total_marks: result.total_marks,
        maximum_marks: result.maximum_marks,
        applicable_marks: result.applicable_marks,
        percentage: result.percentage,
        earned_percentage: result.earned_percentage,
        passed: result.passed,
        ztp_failed: result.ztp_failed,
        passing_percentage: result.passing_percentage,
        counts: result.counts,
        groups: (result.groups || []).map((g) => ({ group: g.group, marks: g.marks, applicable_marks: g.applicable_marks, max_marks: g.max_marks })),
        screen_video_analyzed: Boolean(result.evidence_sources?.screen_video_analyzed),
        screen_actions_observed: result.evidence_sources?.screen_actions_observed ?? null,
        screen_portal_verdict: result.evidence_sources?.screen_portal_verdict || null,
        screen_crm_verdict: result.evidence_sources?.screen_crm_verdict || null,
        screen_consistency: result.evidence_sources?.screen_consistency || null,
        evaluated_at: result.evaluated_at,
      };
      s.evaluation = { ...(s.evaluation || {}), status: "completed", completed_at: result.evaluated_at, error: null, model: result.model, stage: "emailing", stage_label: EVALUATION_STAGES.emailing, stage_at: nowIso() };
      return s;
    });

    // ---- Stage 3: email (never fails the job)
    try {
      await sendResultForSession(sessionId, baseUrl);
    } catch (err) {
      console.error(`[evaluation-job] result email failed for ${sessionId}:`, err.message);
    }
    await setStage(sessionId, "completed");
    return result;
  } catch (err) {
    const message = describeGeminiError(err);
    await updateSession(sessionId, (s) => {
      s.status = SESSION_STATUS.ERROR;
      s.error = `Evaluation failed: ${message}`;
      s.evaluation = { ...(s.evaluation || {}), status: "failed", completed_at: nowIso(), error: message, stage: "failed", stage_label: `Failed: ${message}` };
      return s;
    });
    throw err;
  }
}

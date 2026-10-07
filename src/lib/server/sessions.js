import { db } from "./db";
import { assertValidSessionId, nowIso } from "./storage";

export const SESSION_STATUS = { CREATED: "created", LIVE: "live", ENDED: "ended", EVALUATING: "evaluating", COMPLETED: "completed", ERROR: "error" };

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

export function generateSessionId() {
  const d = new Date();
  return `CERT-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(Math.floor(Math.random() * 1000000), 6)}`;
}

export async function createSession({ process, agent = null, extra = {} }) {
  let id = generateSessionId();
  for (let i = 0; i < 20 && (await db.getSession(id)); i += 1) id = generateSessionId();
  const now = nowIso();
  const session = {
    session_id: id,
    process_id: process.process_id,
    process_name: process.process_name,
    scenario_title: process.scenario?.title || null,
    agent_id: agent?.id || null,
    agent_name: agent?.name || null,
    agent_email: agent?.email || null,
    employee_id: agent?.employee_id || null,
    status: SESSION_STATUS.CREATED,
    created_at: now,
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    ended_reason: null,
    attempts: 0,
    transcript: [],
    transcript_final: false,
    recording: { screen: null, audio: null },
    live: { model: null, token_count: 0 },
    evaluation: { status: "pending", error: null, model: null, completed_at: null },
    result_summary: null,
    invite_email: null,
    result_email: null,
    client_log: null,
    error: null,
    attempt_no: Number.isInteger(extra.attempt_no) && extra.attempt_no > 0 ? extra.attempt_no : 1,
    recertification_of: extra.recertification_of || null,
    updated_at: now,
  };
  return db.createSession(session);
}

export async function getSession(sessionId) {
  assertValidSessionId(sessionId);
  return db.getSession(sessionId);
}

export async function listSessions(opts) {
  return db.listSessions(opts);
}

export async function updateSession(sessionId, updater) {
  assertValidSessionId(sessionId);
  return db.updateSession(sessionId, (s) => {
    const next = updater(s) || s;
    next.updated_at = nowIso();
    return next;
  });
}

export async function getResult(sessionId) {
  assertValidSessionId(sessionId);
  return db.getResult(sessionId);
}

export function sanitizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .slice(0, 5000)
    .map((t, i) => ({
      index: i + 1,
      speaker: t.speaker === "Agent" ? "Agent" : "Customer",
      text: t.text.trim().slice(0, 4000),
      timestamp: typeof t.timestamp === "string" ? t.timestamp : nowIso(),
      offset_seconds: Number.isFinite(Number(t.offset_seconds)) ? Math.max(0, Math.round(Number(t.offset_seconds))) : null,
      interrupted: Boolean(t.interrupted),
    }));
}

/** List view without the heavy payloads. */
export function sessionSummary(session) {
  const { transcript, client_log, ...rest } = session;
  return {
    attempt_no: 1,
    recertification_of: null,
    agent_id: null,
    agent_email: null,
    employee_id: null,
    invite_email: null,
    result_email: null,
    result_summary: null,
    ...rest,
    transcript_turns: Array.isArray(transcript) ? transcript.length : 0,
  };
}

/** Stable identity of an agent across certifications (registered id > email > name). */
export function agentKeyOf(s) {
  if (!s) return null;
  if (s.agent_id) return `id:${s.agent_id}`;
  if (s.agent_email) return `email:${String(s.agent_email).toLowerCase()}`;
  if (s.agent_name && String(s.agent_name).trim()) return `name:${String(s.agent_name).trim().toLowerCase()}`;
  return null;
}

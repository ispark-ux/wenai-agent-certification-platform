import { db } from "./db";
import { getProcess } from "./processes";
import { createSession, getSession, updateSession, getResult, agentKeyOf } from "./sessions";
import { DEFAULT_EMAIL_SETTINGS, normalizeEmailSettings, emailConfigured, parseEmailList, renderInviteEmail, renderResultEmail, sendMail } from "./email";
import { httpError } from "./http";
import { nowIso } from "./storage";

export async function getEmailSettings() {
  const stored = await db.getSetting("email");
  return normalizeEmailSettings(stored || {}, DEFAULT_EMAIL_SETTINGS);
}

export async function saveEmailSettings(input) {
  const existing = await getEmailSettings();
  const next = normalizeEmailSettings(input, existing);
  await db.saveSetting("email", next);
  return next;
}

export function certificationUrl(baseUrl, sessionId) {
  return `${baseUrl}/certification/${sessionId}`;
}

async function deliver({ type, sessionId, settings, to, cc, render }) {
  const recipients = parseEmailList(to);
  const ccList = parseEmailList(cc).filter((e) => !recipients.includes(e));
  const base = { type, to: recipients, cc: ccList, attempted_at: nowIso() };
  if (!emailConfigured(settings)) return { ...base, status: "skipped", reason: "Email not configured" };
  if (!recipients.length) return { ...base, status: "skipped", reason: "No recipient" };
  const { subject, html, text } = render();
  try {
    const info = await sendMail(settings, { to: recipients, cc: ccList, subject, html, text });
    await db.logEmail({ session_id: sessionId, type, to: recipients, cc: ccList, subject, status: "sent", message_id: info.message_id });
    return { ...base, status: "sent", sent_at: nowIso(), subject, message_id: info.message_id };
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[email] ${type} for ${sessionId} failed:`, message);
    await db.logEmail({ session_id: sessionId, type, to: recipients, cc: ccList, subject, status: "failed", error: message });
    return { ...base, status: "failed", error: message, subject };
  }
}

/** All earlier sessions of the same agent for the same process (oldest first). */
export async function agentProcessHistory(processId, agentLike) {
  const key = agentKeyOf(agentLike);
  if (!key) return [];
  const sessions = await db.listSessionsLite({ limit: 5000 });
  return sessions.filter((s) => s.process_id === processId && agentKeyOf(s) === key).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export function recertificationRules(process) {
  const r = process?.recertification || {};
  return { enabled: r.enabled !== false, max_attempts: Number(r.max_attempts) > 0 ? Number(r.max_attempts) : 3, cooldown_hours: Number(r.cooldown_hours) > 0 ? Number(r.cooldown_hours) : 0 };
}

/** Creates a certification session (optionally bound to an agent) and emails the link. */
export async function createCertification({ processId, agentId = null, agentName = "", agentEmail = "", sendEmail = false, baseUrl, recertificationOf = null }) {
  const process_ = await getProcess(processId);
  if (!process_) throw httpError(`Process '${processId}' not found`, 404);
  if (process_.active === false) throw httpError(`Process '${process_.process_name}' is inactive`, 400);

  let agent = null;
  if (agentId) {
    agent = await db.getAgent(agentId);
    if (!agent) throw httpError("Agent not found", 404);
  } else if (agentName || agentEmail) {
    const email = parseEmailList(agentEmail)[0] || null;
    agent = { id: null, name: String(agentName || "").trim().slice(0, 120) || null, email, employee_id: null };
  }

  const history = agent ? await agentProcessHistory(process_.process_id, { agent_id: agent.id, agent_email: agent.email, agent_name: agent.name }) : [];
  const attemptNo = history.filter((h) => h.status !== "created").length + 1;
  const session = await createSession({ process: process_, agent, extra: { attempt_no: attemptNo, recertification_of: recertificationOf || (attemptNo > 1 && history.length ? history[0].recertification_of || history[0].session_id : null) } });
  const url = certificationUrl(baseUrl, session.session_id);
  let email = null;
  if (sendEmail && session.agent_email) email = await sendInviteForSession(session.session_id, baseUrl);
  return { session: email ? await getSession(session.session_id) : session, url, email };
}

export async function sendInviteForSession(sessionId, baseUrl) {
  const session = await getSession(sessionId);
  if (!session) throw httpError("Certification not found", 404);
  if (!session.agent_email) throw httpError("This certification has no agent email. Add an agent with an email address first.", 400);
  const process_ = await getProcess(session.process_id);
  if (!process_) throw httpError("Process not found", 404);
  const settings = await getEmailSettings();
  const url = certificationUrl(baseUrl, session.session_id);
  const status = await deliver({ type: "invite", sessionId, settings, to: [session.agent_email], cc: settings.notify_cc, render: () => renderInviteEmail({ session, process: process_, url }) });
  await updateSession(sessionId, (s) => {
    s.invite_email = status;
    return s;
  });
  return status;
}

/** Emails the scorecard to the configured recipients (+ process emails, + agent). */
export async function sendResultForSession(sessionId, baseUrl) {
  const session = await getSession(sessionId);
  if (!session) throw httpError("Certification not found", 404);
  const result = await getResult(sessionId);
  if (!result) throw httpError("No result available for this certification yet.", 409);
  const process_ = await getProcess(session.process_id);
  if (!process_) throw httpError("Process not found", 404);
  const settings = await getEmailSettings();

  const adminUrl = `${baseUrl}/admin/certification/${sessionId}`;
  const agentUrl = certificationUrl(baseUrl, sessionId);
  const teamTo = parseEmailList([...(settings.notify_to || []), ...(process_.notification_emails || [])]);

  const team = await deliver({ type: "result", sessionId, settings, to: teamTo, cc: settings.notify_cc, render: () => renderResultEmail({ session, result, process: process_, adminUrl, agentUrl, forAgent: false }) });
  let agent = null;
  if (settings.email_agent_result && session.agent_email) {
    agent = await deliver({ type: "result_agent", sessionId, settings, to: [session.agent_email], cc: [], render: () => renderResultEmail({ session, result, process: process_, adminUrl, agentUrl, forAgent: true }) });
  }
  const combined = {
    status: team.status === "sent" || agent?.status === "sent" ? "sent" : team.status === "failed" || agent?.status === "failed" ? "failed" : "skipped",
    team,
    agent,
    attempted_at: nowIso(),
  };
  await updateSession(sessionId, (s) => {
    s.result_email = combined;
    return s;
  });
  return combined;
}

/**
 * Recertification: creates a fresh attempt for the same agent + process (linked
 * to the first attempt), enforcing the process rules (max attempts, cooldown).
 * Unused open links of the same agent are reused instead of piling up.
 */
export async function recertify({ sessionId, sendEmail = true, baseUrl, force = false }) {
  const orig = await getSession(sessionId);
  if (!orig) throw httpError("Certification not found", 404);
  const process_ = await getProcess(orig.process_id);
  if (!process_) throw httpError(`Process '${orig.process_id}' not found`, 404);
  if (process_.active === false) throw httpError(`Process '${process_.process_name}' is inactive`, 400);
  if (!orig.agent_name && !orig.agent_email && !orig.agent_id) throw httpError("This certification has no agent attached - create a new link instead.", 400);

  const rules = recertificationRules(process_);
  const history = await agentProcessHistory(process_.process_id, orig);
  const used = history.filter((h) => h.status !== "created");
  const pendingLink = history.find((h) => h.status === "created");

  if (!force) {
    if (!rules.enabled) throw httpError("Recertification is disabled for this process.", 409);
    if (history.some((h) => ["live", "ended", "evaluating"].includes(h.status))) throw httpError("This agent has a certification in progress - wait for it to finish.", 409);
    if (used.length >= rules.max_attempts) throw httpError(`Maximum attempts reached (${used.length}/${rules.max_attempts}). Use force to override.`, 409);
    const last = used[used.length - 1];
    if (rules.cooldown_hours && last?.ended_at) {
      const readyAt = new Date(last.ended_at).getTime() + rules.cooldown_hours * 3600 * 1000;
      if (Date.now() < readyAt) throw httpError(`Cooldown active - recertification allowed after ${new Date(readyAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.`, 409);
    }
  }

  let session = pendingLink;
  if (!session) {
    const root = orig.recertification_of || history[0]?.session_id || orig.session_id;
    session = await createSession({
      process: process_,
      agent: { id: orig.agent_id || null, name: orig.agent_name || null, email: orig.agent_email || null, employee_id: orig.employee_id || null },
      extra: { attempt_no: used.length + 1, recertification_of: root },
    });
  }
  const url = certificationUrl(baseUrl, session.session_id);
  let email = null;
  if (sendEmail && session.agent_email) email = await sendInviteForSession(session.session_id, baseUrl);
  return { session: email ? await getSession(session.session_id) : session, url, email, reused: Boolean(pendingLink), attempt_no: session.attempt_no || used.length + 1, max_attempts: rules.max_attempts };
}

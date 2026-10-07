import nodemailer from "nodemailer";
import { formatDuration } from "@/lib/format";

export const DEFAULT_EMAIL_SETTINGS = {
  enabled: false,
  smtp_host: "",
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: "",
  smtp_pass: "",
  smtp_ignore_tls_errors: false,
  from_name: "AI Agent Certification",
  from_email: "",
  reply_to: "",
  notify_to: [],
  notify_cc: [],
  email_agent_result: true,
  send_invite_default: true,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value) {
  return EMAIL_RE.test(String(value || "").trim());
}

export function parseEmailList(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[,;\n]+/);
  const out = [];
  for (const item of raw) {
    const v = String(item || "").trim().toLowerCase();
    if (v && isEmail(v) && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 50);
}

export function normalizeEmailSettings(input, existing = DEFAULT_EMAIL_SETTINGS) {
  const src = input || {};
  const base = { ...DEFAULT_EMAIL_SETTINGS, ...(existing || {}) };
  const port = Number(src.smtp_port ?? base.smtp_port);
  const pass = typeof src.smtp_pass === "string" && src.smtp_pass.length > 0 ? src.smtp_pass : base.smtp_pass;
  return {
    enabled: src.enabled === undefined ? base.enabled : Boolean(src.enabled),
    smtp_host: String(src.smtp_host ?? base.smtp_host).trim().slice(0, 200),
    smtp_port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : 587,
    smtp_secure: src.smtp_secure === undefined ? Boolean(base.smtp_secure) : Boolean(src.smtp_secure),
    smtp_user: String(src.smtp_user ?? base.smtp_user).trim().slice(0, 200),
    smtp_pass: String(pass || "").slice(0, 500),
    smtp_ignore_tls_errors: src.smtp_ignore_tls_errors === undefined ? Boolean(base.smtp_ignore_tls_errors) : Boolean(src.smtp_ignore_tls_errors),
    from_name: String(src.from_name ?? base.from_name).trim().slice(0, 120) || "AI Agent Certification",
    from_email: String(src.from_email ?? base.from_email).trim().toLowerCase().slice(0, 200),
    reply_to: String(src.reply_to ?? base.reply_to).trim().toLowerCase().slice(0, 200),
    notify_to: parseEmailList(src.notify_to ?? base.notify_to),
    notify_cc: parseEmailList(src.notify_cc ?? base.notify_cc),
    email_agent_result: src.email_agent_result === undefined ? base.email_agent_result !== false : Boolean(src.email_agent_result),
    send_invite_default: src.send_invite_default === undefined ? base.send_invite_default !== false : Boolean(src.send_invite_default),
  };
}

/** Never return the SMTP password to the browser. */
export function maskEmailSettings(settings) {
  const s = { ...DEFAULT_EMAIL_SETTINGS, ...(settings || {}) };
  return { ...s, smtp_pass: "", smtp_pass_set: Boolean(s.smtp_pass) };
}

export function emailConfigured(settings) {
  return Boolean(settings && settings.enabled && settings.smtp_host && isEmail(settings.from_email));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function sendMail(settings, { to, cc = [], subject, html, text }) {
  if (!emailConfigured(settings)) throw new Error("Email is not configured. Open Admin → Email settings, fill in SMTP details and enable email.");
  const recipients = parseEmailList(to);
  if (!recipients.length) throw new Error("No valid recipient email address.");
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port,
    secure: Boolean(settings.smtp_secure),
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: settings.smtp_pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: settings.smtp_ignore_tls_errors ? { rejectUnauthorized: false } : undefined,
  });
  const info = await withTimeout(
    transporter.sendMail({
      from: `"${settings.from_name.replace(/"/g, "'")}" <${settings.from_email}>`,
      to: recipients.join(", "),
      cc: parseEmailList(cc).join(", ") || undefined,
      replyTo: isEmail(settings.reply_to) ? settings.reply_to : undefined,
      subject,
      html,
      text,
    }),
    40000,
    "SMTP send"
  );
  return { message_id: info.messageId || null, accepted: info.accepted || [], rejected: info.rejected || [], to: recipients, cc: parseEmailList(cc) };
}

// ---------------------------------------------------------------- templates
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<div style="max-width:720px;margin:0 auto;padding:24px">
  <div style="background:#0f172a;color:#fff;border-radius:14px 14px 0 0;padding:18px 24px">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a5b4fc">AI Agent Certification</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${esc(title)}</div>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;padding:24px">${bodyHtml}</div>
  <p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px">This is an automated message from the AI Agent Certification Platform.</p>
</div></body></html>`;
}

function kv(rows) {
  return `<table style="border-collapse:collapse;width:100%;font-size:14px">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#64748b;width:38%">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join("")}</table>`;
}

function button(url, label) {
  return `<a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;margin:14px 0">${esc(label)}</a>`;
}

export function renderInviteEmail({ session, process, url }) {
  const attempt = Number(session.attempt_no) || 1;
  const recert = attempt > 1;
  const subject = recert ? `Recertification (attempt ${attempt}) - ${process.process_name} - ${session.session_id}` : `Your ${process.process_name} certification link - ${session.session_id}`;
  const html = layout(
    `${process.process_name} certification`,
    `<p style="font-size:15px">Hello ${esc(session.agent_name || "Agent")},</p>
${recert ? `<p style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:13px">This is your <strong>recertification - attempt ${attempt}</strong>. Review the feedback from your previous attempt before you start.</p>` : ""}
<p>You have been invited to complete your <strong>${esc(process.process_name)}</strong> voice certification (scenario: <strong>${esc(process.scenario?.title || "")}</strong>, language: ${esc(process.language || "")}).</p>
${kv([
  ["Session ID", `<span style="font-family:monospace">${esc(session.session_id)}</span>`],
  ["Duration", `up to ${esc(process.live_settings?.max_duration_minutes || 15)} minutes`],
])}
<div style="text-align:center">${button(url, "Open certification")}</div>
<p style="font-size:13px;color:#475569">Link: <a href="${esc(url)}">${esc(url)}</a></p>
<h3 style="font-size:14px;margin:18px 0 6px">Before you start</h3>
<ul style="font-size:13px;color:#334155;line-height:1.6;margin:0;padding-left:18px">
  <li>Use desktop Chrome or Edge with a headset in a quiet place.</li>
  <li>When asked, share your <strong>entire screen</strong> and allow the microphone.</li>
  <li>The AI customer speaks first - handle the call exactly as a real customer call.</li>
  <li>Click END CERTIFICATION only after closing the call properly. Your score is emailed automatically.</li>
</ul>`
  );
  const text = `Hello ${session.agent_name || "Agent"},\n\nYou have been invited to complete your ${process.process_name} certification (${process.scenario?.title || ""}).\nSession: ${session.session_id}\nOpen: ${url}\n\nUse desktop Chrome/Edge with a headset, share your entire screen and allow the microphone. The AI customer speaks first.`;
  return { subject, html, text };
}

function statusChip(status) {
  const color = status === "C" ? "#059669" : status === "NC" ? "#e11d48" : "#64748b";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${color};color:#fff;font-size:11px;font-weight:700">${esc(status)}</span>`;
}

export function renderResultEmail({ session, result, process, adminUrl, agentUrl, forAgent = false }) {
  const verdict = result.ztp_failed ? "FAILED (ZTP)" : result.passed ? "PASSED" : "NOT PASSED";
  const verdictColor = result.passed ? "#059669" : "#e11d48";
  const subject = `Certification ${verdict} - ${session.agent_name || "Agent"} - ${process.process_name} - ${result.percentage}%`;
  const groupsTable = `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
<tr style="background:#f8fafc"><th style="text-align:left;padding:8px;border:1px solid #e2e8f0">Section</th><th style="text-align:right;padding:8px;border:1px solid #e2e8f0">Marks</th><th style="text-align:right;padding:8px;border:1px solid #e2e8f0">Applicable</th><th style="text-align:right;padding:8px;border:1px solid #e2e8f0">Max</th></tr>
${(result.groups || [])
  .map((g) => `<tr><td style="padding:8px;border:1px solid #e2e8f0">${esc(g.group)}</td><td style="padding:8px;border:1px solid #e2e8f0;text-align:right;font-weight:700">${g.marks}</td><td style="padding:8px;border:1px solid #e2e8f0;text-align:right">${g.applicable_marks}</td><td style="padding:8px;border:1px solid #e2e8f0;text-align:right">${g.max_marks}</td></tr>`)
  .join("")}
<tr style="background:#f8fafc;font-weight:700"><td style="padding:8px;border:1px solid #e2e8f0">Grand total</td><td style="padding:8px;border:1px solid #e2e8f0;text-align:right">${result.total_marks}</td><td style="padding:8px;border:1px solid #e2e8f0;text-align:right">${result.applicable_marks}</td><td style="padding:8px;border:1px solid #e2e8f0;text-align:right">${result.maximum_marks}</td></tr></table>`;
  const paramsTable = `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:8px">
<tr style="background:#f8fafc"><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Parameter</th><th style="padding:6px;border:1px solid #e2e8f0">Status</th><th style="padding:6px;border:1px solid #e2e8f0">Marks</th><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Reason</th></tr>
${(result.parameters || [])
  .map((p) => `<tr><td style="padding:6px;border:1px solid #e2e8f0"><span style="color:#94a3b8;font-family:monospace">${esc(p.id)}</span> ${esc(p.parameter)}${p.zero_tolerance ? ' <span style="color:#e11d48;font-weight:700">ZTP</span>' : ""}</td><td style="padding:6px;border:1px solid #e2e8f0;text-align:center">${statusChip(p.status)}</td><td style="padding:6px;border:1px solid #e2e8f0;text-align:center;font-family:monospace">${p.marks}/${p.max_marks}</td><td style="padding:6px;border:1px solid #e2e8f0;color:#334155">${esc(p.reason)}</td></tr>`)
  .join("")}</table>`;
  const sa = result.screen_analysis;
  const resColor = (r) => (r === "pass" || r === "observed" || r === "consistent" ? "#059669" : r === "fail" || r === "not_observed" || r === "inconsistent" ? "#e11d48" : r === "partial" ? "#d97706" : "#64748b");
  const resLabel = (r) => ({ pass: "Pass", fail: "Fail", partial: "Partial", unclear: "Unclear", not_applicable: "N/A", observed: "Observed", not_observed: "Not observed", consistent: "Consistent", inconsistent: "Inconsistent" }[r] || r || "—");
  const checkRows = (rows) =>
    rows
      .map((v) => `<tr><td style="padding:6px;border:1px solid #e2e8f0">${esc(v.title)}${v.expected_value ? `<br><span style="font-family:monospace;color:#94a3b8;font-size:11px">expected ${esc(v.expected_value)}</span>` : ""}</td><td style="padding:6px;border:1px solid #e2e8f0;text-align:center;font-weight:700;color:${resColor(v.result)}">${resLabel(v.result)}</td><td style="padding:6px;border:1px solid #e2e8f0;font-family:monospace;font-size:11px">${esc(v.value_seen || "—")}</td><td style="padding:6px;border:1px solid #e2e8f0;color:#334155">${v.timestamp ? `<span style="font-family:monospace;color:#94a3b8">${esc(v.timestamp)}</span> ` : ""}${esc(v.evidence)}</td></tr>`)
      .join("");
  const screenTable = sa?.analyzed
    ? `<h3 style="font-size:14px;margin:18px 0 0">Portal &amp; CRM verification (Gemini watched the screen recording)</h3>
<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px"><tr>
<td style="padding:8px;border:1px solid #e2e8f0"><span style="color:#64748b;font-size:11px">PORTAL WORK</span><br><strong style="color:${resColor(sa.portal_verdict)}">${resLabel(sa.portal_verdict)}</strong></td>
<td style="padding:8px;border:1px solid #e2e8f0"><span style="color:#64748b;font-size:11px">CRM TAGGING</span><br><strong style="color:${resColor(sa.crm_verdict)}">${resLabel(sa.crm_verdict)}</strong></td>
<td style="padding:8px;border:1px solid #e2e8f0"><span style="color:#64748b;font-size:11px">SCREEN VS WHAT AGENT SAID</span><br><strong style="color:${resColor(sa.cross_check?.consistency)}">${resLabel(sa.cross_check?.consistency)}</strong><br><span style="font-size:11px;color:#475569">Screen: ${esc(sa.cross_check?.status_on_screen || "—")} · Told: ${esc(sa.cross_check?.status_told_to_customer || "—")}</span></td></tr></table>
<table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:8px">
<tr style="background:#f8fafc"><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Check</th><th style="padding:6px;border:1px solid #e2e8f0">Result</th><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Seen on screen</th><th style="text-align:left;padding:6px;border:1px solid #e2e8f0">Evidence</th></tr>
${checkRows((sa.verification || []).filter((v) => v.category === "portal"))}
${checkRows((sa.verification || []).filter((v) => v.category === "crm"))}
${checkRows((sa.verification || []).filter((v) => v.category === "conduct"))}</table>
${sa.applications_seen?.length ? `<p style="font-size:12px;color:#475569;margin:8px 0 0"><strong>Applications seen:</strong> ${esc(sa.applications_seen.join(", "))}</p>` : ""}
${sa.concerns?.length ? `<p style="font-size:12px;color:#be123c;margin:6px 0 0"><strong>Concerns:</strong> ${esc(sa.concerns.join(" · "))}</p>` : ""}`
    : `<p style="font-size:12px;color:#64748b;margin:14px 0 0">Screen recording: ${result.evidence_sources?.screen_recording_captured ? "captured but not analysed" : "not captured"} - screen-based parameters marked NA.</p>`;
  const lists = `${result.strengths?.length ? `<h3 style="font-size:14px;margin:18px 0 6px">Strengths</h3><ul style="font-size:13px;color:#334155;margin:0;padding-left:18px">${result.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
${result.improvements?.length ? `<h3 style="font-size:14px;margin:18px 0 6px">Areas of improvement</h3><ul style="font-size:13px;color:#334155;margin:0;padding-left:18px">${result.improvements.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}`;
  const html = layout(
    `Certification result - ${session.agent_name || "Agent"}`,
    `<div style="text-align:center;padding:10px 0 18px">
  <div style="font-size:44px;font-weight:800;color:${verdictColor}">${result.percentage}%</div>
  <div style="font-size:14px;font-weight:700;color:${verdictColor}">${esc(verdict)}</div>
  <div style="font-size:12px;color:#64748b">${result.total_marks} / ${result.applicable_marks} applicable marks · passing ${result.passing_percentage}%${result.ztp_failed ? " · Zero Tolerance parameter failed" : ""}</div>
</div>
${kv([
  ["Agent", esc(session.agent_name || "—") + (session.agent_email ? ` <span style="color:#64748b;font-weight:400">(${esc(session.agent_email)})</span>` : "")],
  ["Employee ID", esc(session.employee_id || "—")],
  ["Process", esc(process.process_name)],
  ["Scenario", esc(process.scenario?.title || "—")],
  ["Date", esc(session.ended_at ? new Date(session.ended_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST" : "—")],
  ["Duration", esc(formatDuration(session.duration_seconds))],
  ["Session ID", `<span style="font-family:monospace">${esc(session.session_id)}</span>`],
])}
<h3 style="font-size:14px;margin:18px 0 0">Section-wise score</h3>${groupsTable}
<h3 style="font-size:14px;margin:18px 0 0">Parameter-wise evaluation</h3>${paramsTable}
${screenTable}
${result.overall_feedback ? `<h3 style="font-size:14px;margin:18px 0 6px">Overall feedback</h3><p style="font-size:13px;color:#334155;margin:0">${esc(result.overall_feedback)}</p>` : ""}
${lists}
<div style="text-align:center;margin-top:18px">${forAgent ? button(agentUrl, "View your scorecard") : button(adminUrl, "Open in admin panel")}</div>
${forAgent ? "" : `<p style="font-size:12px;color:#64748b;text-align:center">Agent link: <a href="${esc(agentUrl)}">${esc(agentUrl)}</a></p>`}`
  );
  const text = `Certification ${verdict}\nAgent: ${session.agent_name || "—"}\nProcess: ${process.process_name} (${process.scenario?.title || ""})\nScore: ${result.percentage}% (${result.total_marks}/${result.applicable_marks})\nSession: ${session.session_id}\n\n${(result.parameters || []).map((p) => `${p.id} ${p.parameter}: ${p.status} ${p.marks}/${p.max_marks} - ${p.reason}`).join("\n")}\n\n${forAgent ? agentUrl : adminUrl}`;
  return { subject, html, text };
}

export function renderTestEmail(settings) {
  return {
    subject: "AI Agent Certification - SMTP test",
    html: layout("SMTP test successful", `<p>Your email settings are working.</p>${kv([["SMTP host", esc(settings.smtp_host)], ["Port", esc(settings.smtp_port)], ["From", esc(settings.from_email)]])}`),
    text: `SMTP test successful. Host ${settings.smtp_host}:${settings.smtp_port}, from ${settings.from_email}.`,
  };
}

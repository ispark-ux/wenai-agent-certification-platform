import { Type } from "@google/genai";
import { getGeminiClient, getGeminiConfig, generateStructuredJson } from "./gemini";

/**
 * Stage 1 of the evaluation: Gemini WATCHES the screen recording and VERIFIES
 * the agent's portal / CRM work against the scenario:
 *
 *   - did the agent open the order portal (e.g. Shopify)?
 *   - did the agent search the EXACT order ID of this scenario (e.g. ST12345)?
 *   - did the matching order open, and what status / ETA did the portal show?
 *   - did the agent open the CRM record, select a disposition, write remarks, save?
 *   - does what was on screen match what the agent TOLD the customer?
 *
 * The video is uploaded to the Gemini Files API (no inline size limit), then a
 * vision pass returns a structured, timestamped report with one verdict per
 * verification check and per expected action. Stage 2 (the scorecard) and the
 * result email use that report as evidence.
 */

const FILE_POLL_INTERVAL_MS = 4000;
const FILE_PROCESSING_TIMEOUT_MS = 8 * 60 * 1000;

const STATUS_VALUES = ["observed", "not_observed", "unclear"];
const CHECK_RESULTS = ["pass", "fail", "partial", "unclear", "not_applicable"];
const CONSISTENCY_VALUES = ["consistent", "inconsistent", "unclear", "not_applicable"];

export const SCREEN_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    video_readable: { type: Type.BOOLEAN },
    readability_notes: { type: Type.STRING },
    summary: { type: Type.STRING },
    applications_seen: { type: Type.ARRAY, items: { type: Type.STRING } },
    observed_actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { timestamp: { type: Type.STRING }, application: { type: Type.STRING }, action: { type: Type.STRING }, details: { type: Type.STRING } },
        required: ["timestamp", "application", "action", "details"],
      },
    },
    verification: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          result: { type: Type.STRING, enum: CHECK_RESULTS },
          timestamp: { type: Type.STRING },
          evidence: { type: Type.STRING },
          value_seen: { type: Type.STRING },
        },
        required: ["id", "result", "timestamp", "evidence", "value_seen"],
      },
    },
    expected_actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING },
          category: { type: Type.STRING, enum: ["portal", "crm", "other"] },
          status: { type: Type.STRING, enum: STATUS_VALUES },
          timestamp: { type: Type.STRING },
          evidence: { type: Type.STRING },
        },
        required: ["action", "category", "status", "timestamp", "evidence"],
      },
    },
    key_facts_seen: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { fact: { type: Type.STRING }, value: { type: Type.STRING }, timestamp: { type: Type.STRING } },
        required: ["fact", "value", "timestamp"],
      },
    },
    cross_check: {
      type: Type.OBJECT,
      properties: {
        status_on_screen: { type: Type.STRING },
        status_told_to_customer: { type: Type.STRING },
        consistency: { type: Type.STRING, enum: CONSISTENCY_VALUES },
        notes: { type: Type.STRING },
      },
      required: ["status_on_screen", "status_told_to_customer", "consistency", "notes"],
    },
    concerns: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["video_readable", "readability_notes", "summary", "applications_seen", "observed_actions", "verification", "expected_actions", "key_facts_seen", "cross_check", "concerns"],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uploads a buffer to the Gemini Files API and waits until it is ACTIVE. */
export async function uploadMediaToGemini({ buffer, mimeType, displayName, onProgress }) {
  const ai = getGeminiClient();
  const blob = new Blob([buffer], { type: mimeType });
  let file = await ai.files.upload({ file: blob, config: { mimeType, displayName } });
  const started = Date.now();
  let lastState = file.state;
  while (file.state === "PROCESSING" || file.state === "STATE_UNSPECIFIED") {
    if (Date.now() - started > FILE_PROCESSING_TIMEOUT_MS) {
      throw new Error(`Gemini took too long to process the uploaded ${displayName} (still ${file.state} after ${Math.round(FILE_PROCESSING_TIMEOUT_MS / 60000)} minutes).`);
    }
    await sleep(FILE_POLL_INTERVAL_MS);
    file = await ai.files.get({ name: file.name });
    if (file.state !== lastState) {
      lastState = file.state;
      if (onProgress) onProgress(file.state);
    }
  }
  if (file.state !== "ACTIVE") {
    throw new Error(`Gemini could not process the uploaded ${displayName} (state ${file.state}${file.error?.message ? `: ${file.error.message}` : ""}).`);
  }
  return {
    name: file.name,
    uri: file.uri,
    mimeType: file.mimeType || mimeType,
    sizeBytes: Number(file.sizeBytes) || buffer.length,
    async cleanup() {
      try {
        await ai.files.delete({ name: file.name });
      } catch {
        /* files expire automatically after 48h */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Verification checklist - built from the process configuration
// ---------------------------------------------------------------------------
const PORTAL_WORDS = /\b(shopify|portal|order|magento|woocommerce|admin|dashboard|panel|backend|website|site)\b/i;
const CRM_WORDS = /\b(crm|ticket|disposition|tag|tagging|remark|note|case|escalat|zoho|freshdesk|salesforce|zendesk|ameyo|lead)\b/i;

function humanKey(key) {
  return String(key || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Identifier-like facts from the customer profile (order id, ticket id, mobile number, email, awb ...). */
export function identifierFacts(process) {
  const profile = process.customer_profile || {};
  const skip = new Set(["name", "gender", "mood", "product", "language", "age", "city"]);
  return Object.entries(profile)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && String(v).trim() !== "")
    .filter(([k, v]) => /id|number|no\b|phone|mobile|email|awb|tracking|account|ticket|pnr|ref/i.test(k) || /^[A-Z0-9#-]{5,}$/.test(String(v).trim()))
    .map(([k, v]) => ({ key: k, label: humanKey(k), value: String(v).trim() }));
}

function portalName(process) {
  const actions = (process.expected_portal_actions || []).join(" ");
  const m = /\b(shopify|magento|woocommerce|salesforce|zoho|freshdesk|zendesk)\b/i.exec(actions);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : "the order / customer portal";
}

function crmName(process) {
  const actions = (process.expected_crm_actions || []).join(" ");
  const m = /\b(zoho|freshdesk|salesforce|zendesk|ameyo|hubspot|leadsquared)\b/i.exec(actions);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : "the CRM / ticketing tool";
}

/**
 * The checks Gemini must answer about the video. Generic across processes:
 * portal opened → exact ID searched → matching record opened → status read →
 * CRM record opened → disposition → remarks → saved. IDs come from the customer
 * profile (e.g. order_id: ST12345), tool names from the expected actions.
 */
export function buildVerificationChecks(process) {
  const ids = identifierFacts(process);
  const hidden = process.scenario?.hidden_information || {};
  const portal = portalName(process);
  const crm = crmName(process);
  const hasPortal = (process.expected_portal_actions || []).length > 0 || ids.length > 0;
  const hasCrm = (process.expected_crm_actions || []).length > 0;
  const checks = [];

  if (hasPortal) {
    checks.push({ id: "portal_opened", category: "portal", title: `Opened ${portal}`, question: `Was ${portal} (orders/customer admin) actually opened on screen during the call?` });
    for (const f of ids) {
      checks.push({
        id: `searched_${f.key}`,
        category: "portal",
        title: `Searched ${f.label} ${f.value}`,
        question: `Did the agent type / search the exact ${f.label} "${f.value}" in ${portal}? Read the search box or URL. If a DIFFERENT value was searched, result = fail and put the value actually seen in value_seen.`,
        expected_value: f.value,
      });
      checks.push({
        id: `record_opened_${f.key}`,
        category: "portal",
        title: `Opened the record for ${f.label} ${f.value}`,
        question: `Was the detail page / record for ${f.label} "${f.value}" opened (ID visible in the page heading, URL or detail panel)? If another record was opened, result = fail and put its ID in value_seen.`,
        expected_value: f.value,
      });
    }
    checks.push({
      id: "status_checked",
      category: "portal",
      title: "Checked the record status / details",
      question: `Did the agent view the status / fulfilment / delivery details of the record? Put the EXACT status text displayed on screen in value_seen (e.g. "Unfulfilled", "Delayed", "In transit", ETA date).${hidden.order_status ? ` The scenario's real status is "${hidden.order_status}"${hidden.expected_delivery ? ` with delivery "${hidden.expected_delivery}"` : ""} - report what the screen shows even if it differs.` : ""}`,
      expected_value: hidden.order_status || "",
    });
  }
  if (hasCrm) {
    checks.push({ id: "crm_opened", category: "crm", title: `Opened ${crm}`, question: `Was ${crm} opened during the call (a ticket / lead / interaction record, not just the tool's home page)?` });
    checks.push({ id: "crm_record_matches", category: "crm", title: "CRM record belongs to this customer / order", question: `Does the CRM record that was opened or created correspond to this customer${ids.length ? ` (${ids.map((f) => `${f.label} ${f.value}`).join(", ")}${process.customer_profile?.name ? `, name ${process.customer_profile.name}` : ""})` : ""}? If another customer's record is used, result = fail.` });
    checks.push({ id: "disposition_selected", category: "crm", title: "Disposition / tag selected", question: "Was a disposition / tag / category selected in the CRM? Put the exact option text in value_seen and judge whether it fits the scenario (correct = pass, clearly wrong category = fail)." });
    checks.push({ id: "remarks_added", category: "crm", title: "Remarks / notes added", question: "Were remarks or notes typed into the CRM record? Quote the visible text in value_seen (summarise if long)." });
    checks.push({ id: "crm_saved", category: "crm", title: "CRM record saved / submitted", question: 'Was the CRM record saved / submitted / closed (Save / Submit / Update button clicked, confirmation toast, or status changed)? If the agent typed but never saved, result = fail.' });
    checks.push({ id: "escalation_raised", category: "crm", title: "Escalation / case raised", question: `Was an escalation / case / follow-up ticket created or marked in the CRM? ${/escalat/i.test(JSON.stringify(process.expected_crm_actions || [])) ? "This scenario expects an escalation." : "This scenario does NOT require an escalation - result = not_applicable if none was raised, and flag it in concerns if one was wrongly raised."}` });
  }
  checks.push({ id: "only_work_apps", category: "conduct", title: "Only work applications used during the call", question: "Apart from the portal/CRM/this certification page, did the agent use unrelated applications or websites during the call (social media, video, personal chat, games)? pass = none, fail = yes (name them with timestamps in evidence)." });
  return checks;
}

function fmtOffset(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function lines(items, fallback = "- (none specified)") {
  return Array.isArray(items) && items.length ? items.map((i) => `- ${i}`).join("\n") : fallback;
}

export function buildScreenAnalysisPrompt({ process, session, transcript, checks }) {
  const profile = process.customer_profile || {};
  const facts = Object.entries(profile)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "" && k !== "mood")
    .map(([k, v]) => `- ${humanKey(k)}: ${v}`)
    .join("\n");
  const ids = identifierFacts(process);
  const hidden = process.scenario?.hidden_information || {};
  const screenRubric = (process.rubric || []).filter((r) => r.evidence_source === "screen").map((r) => `- ${r.id} ${r.parameter}: ${r.guideline || ""}`);
  const agentLines = (transcript || []).filter((t) => t.speaker === "Agent");
  const transcriptText = (transcript || [])
    .slice(0, 400)
    .map((t) => `[${fmtOffset(t.offset_seconds)}] ${t.speaker}: ${t.text}`)
    .join("\n");

  return `You are a strict quality auditor reviewing the SCREEN RECORDING of a contact-center agent's computer during a customer-support certification call for "${process.process_name}". Watch the ENTIRE video frame by frame and verify what the agent ACTUALLY did in the portal and CRM. Report only what is visible.

SCENARIO: ${process.scenario?.title || "customer call"}
Customer details for this call (the agent is expected to look these up):
${facts || "- (none)"}
${ids.length ? `\nTHE EXACT IDENTIFIER(S) THE AGENT MUST SEARCH: ${ids.map((f) => `${f.label} = "${f.value}"`).join(", ")}. Read the search box, URL and page headings carefully and compare character by character. A similar-looking but different value counts as WRONG.` : ""}
${hidden.order_status ? `\nREAL STATUS IN THE SCENARIO (for comparison only - report what the screen shows, do not assume): status "${hidden.order_status}"${hidden.expected_delivery ? `, delivery "${hidden.expected_delivery}"` : ""}.` : ""}

EXPECTED PORTAL ACTIONS:
${lines(process.expected_portal_actions)}

EXPECTED CRM ACTIONS:
${lines(process.expected_crm_actions)}

EVALUATOR NOTES (context):
${process.evaluator_notes?.trim() || "(none)"}

SCREEN-BASED SCORECARD PARAMETERS (the final auditor decides these from your report):
${screenRubric.length ? screenRubric.join("\n") : "- (none)"}

VERIFICATION CHECKLIST - answer EVERY item (use the exact "id"):
${checks.map((c, i) => `${i + 1}. id="${c.id}" [${c.category}] ${c.title}\n   ${c.question}`).join("\n")}
Result values: "pass" (clearly seen and correct), "fail" (video is readable and it did not happen / wrong value / wrong record), "partial" (attempted but incomplete, e.g. typed but not saved), "unclear" (cannot tell: window not visible, text too small, recording cut), "not_applicable" (the check does not apply to this call). Always give the timestamp (mm:ss from recording start) and the visible evidence (window title, text shown, button clicked). "value_seen" = the exact value visible on screen (ID typed, status text, disposition option, remark text) or "" if none.

WHAT ELSE TO PRODUCE
A. "observed_actions": chronological list of meaningful on-screen actions - app/website opened (window titles, URLs, logos), search text typed (quote it), records/orders opened (quote IDs), statuses/fields displayed (quote values), dropdowns/dispositions selected, remarks typed, buttons clicked (Save/Submit/Escalate), tab switches. Skip idle periods.
B. "expected_actions": one entry for EVERY expected portal action and EVERY expected CRM action listed above (keep the same wording) with status "observed" / "not_observed" / "unclear", timestamp and evidence.
C. "key_facts_seen": values visible on screen - ID searched, order/record status, delivery date/ETA, disposition selected, remarks typed, ticket/escalation IDs.
D. "cross_check": compare the status/ETA shown on screen with what the agent TOLD the customer (see the agent's lines in the transcript). "consistent" = the agent relayed what the screen showed; "inconsistent" = the agent told the customer something different from the screen (or stated a status without ever checking the portal - say so); "unclear" / "not_applicable" as appropriate. Quote both sides.
E. "applications_seen": distinct applications/websites visible (e.g. "Shopify admin - Orders", "Zoho CRM", "YouTube").
F. "concerns": anything QA must know - unrelated browsing or entertainment during the call, personal messaging, sensitive data exposed, wrong record opened, status stated without checking, recording stopped early. Empty array if none.
G. "video_readable": false only if the recording is black/blank/unreadable for most of its length (explain in readability_notes).

STRICT RULES
- Report ONLY what is actually visible. Never assume an action happened because it was expected or because the agent said so.
- When text is legible, quote IDs, statuses, dispositions and remarks EXACTLY as displayed. When it is not legible, say "not legible" rather than guessing.
- The recording starts a few seconds BEFORE the call audio; transcript timestamps are relative to the call start and are given only to correlate speech with the screen.
- Call duration: ${fmtOffset(session.duration_seconds)}. Recording duration (approx.): ${fmtOffset(session.recording?.screen?.duration_seconds)}.

WHAT THE AGENT TOLD THE CUSTOMER (agent lines only):
${agentLines.length ? agentLines.map((t) => `[${fmtOffset(t.offset_seconds)}] ${t.text}`).join("\n") : "(the agent said nothing that was transcribed)"}

FULL TRANSCRIPT (for correlation only):
${transcriptText || "(no transcript)"}

Return ONLY the JSON object described by the schema.`;
}

function clampStr(v, n = 500) {
  return String(v ?? "").trim().slice(0, n);
}

export function normalizeScreenAnalysis(raw, process, checks) {
  const expectedPortal = Array.isArray(process.expected_portal_actions) ? process.expected_portal_actions : [];
  const expectedCrm = Array.isArray(process.expected_crm_actions) ? process.expected_crm_actions : [];
  const normStatus = (s) => (STATUS_VALUES.includes(s) ? s : "unclear");
  const normResult = (r) => (CHECK_RESULTS.includes(r) ? r : "unclear");

  // --- verification checklist: one row per configured check
  const rawChecks = Array.isArray(raw?.verification) ? raw.verification : [];
  const byId = new Map(rawChecks.filter((c) => c && c.id).map((c) => [clampStr(c.id, 80).toLowerCase(), c]));
  const verification = (checks || []).map((c) => {
    const v = byId.get(c.id.toLowerCase());
    return {
      id: c.id,
      category: c.category,
      title: c.title,
      expected_value: c.expected_value || "",
      result: v ? normResult(v.result) : "unclear",
      timestamp: v ? clampStr(v.timestamp, 20) : "",
      evidence: v ? clampStr(v.evidence, 700) : "No verdict returned by the vision model for this check.",
      value_seen: v ? clampStr(v.value_seen, 300) : "",
    };
  });

  // --- expected actions: one verdict per configured action
  const expectedList = Array.isArray(raw?.expected_actions) ? raw.expected_actions : [];
  const matchVerdict = (action) => {
    const needle = clampStr(action).toLowerCase();
    return expectedList.find((e) => clampStr(e.action).toLowerCase() === needle) || expectedList.find((e) => needle && clampStr(e.action).toLowerCase().includes(needle.slice(0, 20)));
  };
  const expected = [...expectedPortal.map((a) => ({ action: a, category: "portal" })), ...expectedCrm.map((a) => ({ action: a, category: "crm" }))].map(({ action, category }) => {
    const verdict = matchVerdict(action);
    return {
      action: clampStr(action, 200),
      category,
      status: verdict ? normStatus(verdict.status) : "unclear",
      timestamp: verdict ? clampStr(verdict.timestamp, 20) : "",
      evidence: verdict ? clampStr(verdict.evidence, 600) : "No verdict returned by the vision model for this action.",
    };
  });
  for (const e of expectedList) {
    const txt = clampStr(e.action, 200);
    if (txt && !expected.some((x) => x.action.toLowerCase() === txt.toLowerCase())) {
      expected.push({ action: txt, category: ["portal", "crm"].includes(e.category) ? e.category : "other", status: normStatus(e.status), timestamp: clampStr(e.timestamp, 20), evidence: clampStr(e.evidence, 600) });
    }
  }

  const observed = (Array.isArray(raw?.observed_actions) ? raw.observed_actions : []).slice(0, 300).map((o) => ({
    timestamp: clampStr(o.timestamp, 20),
    application: clampStr(o.application, 120),
    action: clampStr(o.action, 300),
    details: clampStr(o.details, 600),
  }));

  const cc = raw?.cross_check || {};
  const crossCheck = {
    status_on_screen: clampStr(cc.status_on_screen, 300),
    status_told_to_customer: clampStr(cc.status_told_to_customer, 300),
    consistency: CONSISTENCY_VALUES.includes(cc.consistency) ? cc.consistency : "unclear",
    notes: clampStr(cc.notes, 1000),
  };

  const counts = {
    observed: expected.filter((e) => e.status === "observed").length,
    not_observed: expected.filter((e) => e.status === "not_observed").length,
    unclear: expected.filter((e) => e.status === "unclear").length,
    checks_pass: verification.filter((v) => v.result === "pass").length,
    checks_fail: verification.filter((v) => v.result === "fail").length,
    checks_partial: verification.filter((v) => v.result === "partial").length,
    checks_unclear: verification.filter((v) => v.result === "unclear").length,
    checks_na: verification.filter((v) => v.result === "not_applicable").length,
  };

  const portalChecks = verification.filter((v) => v.category === "portal");
  const crmChecks = verification.filter((v) => v.category === "crm");
  const verdictFor = (rows) => {
    const applicable = rows.filter((r) => r.result !== "not_applicable");
    if (!applicable.length) return "not_applicable";
    if (applicable.every((r) => r.result === "unclear")) return "unclear";
    if (applicable.some((r) => r.result === "fail")) return "fail";
    if (applicable.some((r) => r.result === "partial" || r.result === "unclear")) return "partial";
    return "pass";
  };

  return {
    analyzed: true,
    video_readable: raw?.video_readable !== false,
    readability_notes: clampStr(raw?.readability_notes, 1000),
    summary: clampStr(raw?.summary, 3000),
    applications_seen: (Array.isArray(raw?.applications_seen) ? raw.applications_seen : []).map((a) => clampStr(a, 120)).filter(Boolean).slice(0, 40),
    observed_actions: observed,
    verification,
    portal_verdict: verdictFor(portalChecks),
    crm_verdict: verdictFor(crmChecks),
    expected_actions: expected,
    key_facts_seen: (Array.isArray(raw?.key_facts_seen) ? raw.key_facts_seen : []).slice(0, 60).map((f) => ({ fact: clampStr(f.fact, 120), value: clampStr(f.value, 300), timestamp: clampStr(f.timestamp, 20) })),
    cross_check: crossCheck,
    concerns: (Array.isArray(raw?.concerns) ? raw.concerns : []).map((c) => clampStr(c, 500)).filter(Boolean).slice(0, 30),
    counts,
  };
}

/**
 * Runs the vision pass. `videoBuffer` is the screen.webm content.
 */
export async function analyzeScreenRecording({ process, session, transcript, videoBuffer, mimeType = "video/webm", onStage }) {
  const cfg = getGeminiConfig();
  const settings = process.screen_analysis || {};
  const fps = Number.isFinite(Number(settings.fps)) && Number(settings.fps) > 0 ? Math.min(5, Number(settings.fps)) : 1;
  const checks = buildVerificationChecks(process);

  if (onStage) onStage("uploading_video");
  const uploaded = await uploadMediaToGemini({ buffer: videoBuffer, mimeType, displayName: `${session.session_id}-screen`, onProgress: () => onStage && onStage("processing_video") });
  try {
    if (onStage) onStage("analysing_screen");
    const prompt = buildScreenAnalysisPrompt({ process, session, transcript, checks });
    const parts = [{ text: prompt }, { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType }, videoMetadata: { fps } }];
    const { data, usage } = await generateStructuredJson({ model: cfg.screenAnalysisModel, parts, schema: SCREEN_ANALYSIS_SCHEMA, temperature: 0.1, mediaResolution: cfg.screenMediaResolution });
    const analysis = normalizeScreenAnalysis(data, process, checks);
    return { ...analysis, model: cfg.screenAnalysisModel, fps, video_size_bytes: uploaded.sizeBytes, usage };
  } finally {
    await uploaded.cleanup();
  }
}

export function screenAnalysisForPrompt(analysis) {
  if (!analysis || !analysis.analyzed) return null;
  return {
    video_readable: analysis.video_readable,
    readability_notes: analysis.readability_notes,
    summary: analysis.summary,
    portal_verdict: analysis.portal_verdict,
    crm_verdict: analysis.crm_verdict,
    verification: analysis.verification,
    cross_check: analysis.cross_check,
    applications_seen: analysis.applications_seen,
    expected_actions: analysis.expected_actions,
    key_facts_seen: analysis.key_facts_seen,
    observed_actions: analysis.observed_actions.slice(0, 120),
    concerns: analysis.concerns,
  };
}

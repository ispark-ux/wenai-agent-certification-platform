import { Type } from "@google/genai";
import { generateStructuredJson, getGeminiConfig } from "./gemini";
import { db } from "./db";
import { rubricGroups } from "@/lib/rubric";
import { screenAnalysisForPrompt, uploadMediaToGemini } from "./screen-analysis";

const MAX_INLINE_AUDIO_BYTES = 12 * 1024 * 1024; // base64 inflates ~33%; stay under the 20 MB inline limit
const VALID_STATUS = new Set(["C", "NC", "NA"]);

export const EVALUATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    parameters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          status: { type: Type.STRING, enum: ["C", "NC", "NA"] },
          marks: { type: Type.INTEGER },
          reason: { type: Type.STRING },
          evidence: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: { speaker: { type: Type.STRING }, text: { type: Type.STRING } }, required: ["speaker", "text"] },
          },
        },
        required: ["id", "status", "marks", "reason", "evidence"],
      },
    },
    resolution_achieved: { type: Type.BOOLEAN },
    overall_feedback: { type: Type.STRING },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    improvements: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["parameters", "resolution_achieved", "overall_feedback", "strengths", "improvements"],
};

function fmtOffset(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function transcriptAsText(transcript) {
  if (!transcript.length) return "(EMPTY - the agent never produced any transcribed speech)";
  return transcript.map((t) => `[#${t.index} ${fmtOffset(t.offset_seconds)}${t.interrupted ? " interrupted" : ""}] ${t.speaker}: ${t.text}`).join("\n");
}

export function buildEvaluationPrompt({ process, session, transcript, recordingInfo, audioAttached, screenAnalysis = null }) {
  const rubric = (process.rubric || []).map((r) => ({
    id: r.id,
    group: r.group,
    parameter: r.parameter,
    max_marks: r.max_marks,
    evidence_source: r.evidence_source || "transcript",
    zero_tolerance: Boolean(r.zero_tolerance),
    guideline: r.guideline || "",
  }));
  const ztpIds = rubric.filter((r) => r.zero_tolerance).map((r) => r.id);

  const scenario = process.scenario || {};
  const structuredScenario = {
    title: scenario.title,
    customer_problem: scenario.customer_problem,
    opening_line: scenario.opening_line,
    hidden_information: scenario.hidden_information,
    customer_profile: process.customer_profile,
    required_probing: process.required_probing,
    expected_portal_actions: process.expected_portal_actions,
    expected_crm_actions: process.expected_crm_actions,
  };

  const metadata = {
    session_id: session.session_id,
    agent_name: session.agent_name,
    started_at: session.started_at,
    ended_at: session.ended_at,
    duration_seconds: session.duration_seconds,
    ended_reason: session.ended_reason,
    transcript_turns: transcript.length,
    agent_turns: transcript.filter((t) => t.speaker === "Agent").length,
    customer_turns: transcript.filter((t) => t.speaker === "Customer").length,
  };

  const screenForPrompt = screenAnalysisForPrompt(screenAnalysis);
  const screenLine = screenForPrompt
    ? `Screen recording: CAPTURED AND ANALYSED by a vision model (see SCREEN RECORDING ANALYSIS below) - portal verdict: ${screenAnalysis.portal_verdict}, CRM verdict: ${screenAnalysis.crm_verdict}; checks ${screenAnalysis.counts.checks_pass} pass / ${screenAnalysis.counts.checks_fail} fail / ${screenAnalysis.counts.checks_partial} partial / ${screenAnalysis.counts.checks_unclear} unclear; screen-vs-speech consistency: ${screenAnalysis.cross_check?.consistency}.${screenAnalysis.video_readable ? "" : " WARNING: the vision model reported the video as largely unreadable."}`
    : recordingInfo.screen
      ? `Screen recording: captured (${recordingInfo.screen.duration_seconds ?? "?"} s) but it could NOT be analysed${recordingInfo.screen_analysis_error ? ` (${recordingInfo.screen_analysis_error})` : ""} - you cannot see what the agent did on screen.`
      : "Screen recording: NOT available.";
  const screenRule = screenForPrompt
    ? `"screen": judge from the SCREEN RECORDING ANALYSIS below - especially its "verification" checklist (portal opened, exact ID searched, matching record opened, status read, CRM record opened, disposition selected, remarks added, saved) and "cross_check". Rules: check result "pass" = compliant evidence; "fail" = the recording is readable and the step did NOT happen or a WRONG value/record was used - mark NC; "partial" = attempted but incomplete (e.g. typed remarks but never saved) - partial marks; "unclear" = cannot be verified - NA with an explanation; "not_applicable" - ignore. For CRM Disposition the disposition must be selected, fit the scenario AND be saved. Quote the timestamp and visible evidence in the evidence array using speaker "Screen" (e.g. text "01:42 Shopify - searched ST12345, order opened, status Delayed"). Use the analysis to corroborate transcript parameters too: Accurate Probing / "checked the status" is only fully credible when the portal was actually seen being used with the correct ID; for Correct and Complete Information compare cross_check.status_on_screen with what the agent told the customer - if the agent stated a status WITHOUT checking the portal or contradicted the screen, say so and deduct. Items in "concerns" (unrelated browsing, personal messaging, wrong record) count against Professionalism / Active Listening where relevant.`
    : `"screen": the screen recording has NOT been analysed. Portal/CRM parameters MUST be "NA" unless the transcript contains explicit, verifiable evidence (e.g. the agent verbally confirms the exact disposition). Never assume portal/CRM activity happened because the scenario expected it.`;
  return `You are a professional contact-center certification auditor.

Evaluate the AGENT only. The "Customer" in the transcript is an AI role-player following the scenario - never score the customer.

STRICT RULES
1. Do not invent evidence. Transcript evidence items must be VERBATIM quotes copied from the transcript lines below with speaker "Agent" or "Customer". Screen evidence items use speaker "Screen" and must come from the SCREEN RECORDING ANALYSIS (timestamp + what was visible). If no evidence exists for a parameter, return an empty evidence array and explain in "reason".
2. Evaluate EVERY rubric parameter exactly once, in the same order, using the exact "id" values.
3. status must be "C" (compliant), "NC" (non-compliant) or "NA" (not applicable / cannot be verified from the available evidence).
4. marks must be an integer from 0 to max_marks. NA must have 0 marks. C normally means full or near-full marks; NC means partial or zero marks. Be fair but strict - an auditor does not award marks for things that did not happen.
5. Use the EVALUATOR NOTES and any hidden scenario information to judge whether the agent's information was correct and complete. Information that contradicts them is NC.
6. If the situation for a parameter never arose (no hold, no transfer, no escalation needed and none promised), use NA.
7. Judge from the evidence source listed for each parameter:
   - "transcript": judge from the transcript.
   - "audio": ${audioAttached ? "the full conversation audio IS attached - judge rate of speech, clarity, pronunciation, modulation, enthusiasm and dead air directly from the audio and mention what you heard in the reason." : "NO audio is available - judge only from textual indicators in the transcript, state clearly in the reason that the assessment is transcript-based, and use NA if it truly cannot be assessed."}
   - ${screenRule}
8. ${ztpIds.length ? `Zero Tolerance parameters (${ztpIds.join(", ")}): mark NC ONLY for genuinely rude, sarcastic, argumentative or disrespectful behaviour by the agent. NC here fails the entire certification, so be certain and quote the exact words.` : "There are no zero-tolerance parameters."}
9. The transcript is speech-to-text output. Do not penalise grammar or pronunciation for obvious transcription artifacts; penalise only genuine agent errors.
10. Timestamps are mm:ss from the start of the call. Gaps > 10 s between a customer turn and the agent's reply with no explanation may indicate dead air.
11. If the transcript is empty or the agent never spoke, mark transcript-based parameters NC with 0 marks (not NA) and explain, except parameters whose situation never arose (hold/transfer/escalation/CRM) which stay NA.
12. Write reasons in concise professional English (quotes may remain in Hindi/Hinglish).

AVAILABLE EVIDENCE
- Transcript: ${transcript.length ? "yes" : "EMPTY"} (${metadata.agent_turns} agent turns, ${metadata.customer_turns} customer turns)
- Conversation audio: ${audioAttached ? "yes, attached (microphone + AI customer mixed)" : "not available"}
- ${screenLine}

PROCESS: ${process.process_name} (${process.process_id}) · Language: ${process.language || "n/a"} · Scenario: ${scenario.title || "n/a"}

AI CUSTOMER ROLE PROMPT (what the AI customer was instructed to do - use it to understand the scenario and what a correct resolution looks like):
${process.ai_prompt?.trim() || "(not provided - see structured scenario below)"}

EVALUATOR NOTES (hidden from the agent - correct resolution / expectations):
${process.evaluator_notes?.trim() || "(none provided)"}

STRUCTURED SCENARIO (may be partial):
${JSON.stringify(structuredScenario, null, 2)}

RUBRIC (grouped; grand total ${rubric.reduce((s, r) => s + r.max_marks, 0)}):
${JSON.stringify(rubric, null, 2)}

SESSION METADATA:
${JSON.stringify(metadata, null, 2)}

RECORDING METADATA:
${JSON.stringify(recordingInfo, null, 2)}

SCREEN RECORDING ANALYSIS (what a vision model saw on the agent's screen; timestamps mm:ss from recording start):
${screenForPrompt ? JSON.stringify(screenForPrompt, null, 2) : "(not available)"}

TRANSCRIPT (chronological):
${transcriptAsText(transcript)}

Return ONLY the JSON object described by the schema: { "parameters": [{ "id", "status", "marks", "reason", "evidence": [{ "speaker", "text" }] }], "resolution_achieved", "overall_feedback", "strengths", "improvements" }.`;
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function verifyEvidence(evidence, transcript, screenAnalysis = null) {
  if (!Array.isArray(evidence)) return [];
  const lines = transcript.map((t) => ({ ...t, norm: normalizeForMatch(t.text) }));
  const screenItems = screenAnalysis?.analyzed
    ? [
        ...screenAnalysis.observed_actions.map((o) => ({ ts: o.timestamp, norm: normalizeForMatch(`${o.application} ${o.action} ${o.details}`) })),
        ...screenAnalysis.expected_actions.map((o) => ({ ts: o.timestamp, norm: normalizeForMatch(`${o.action} ${o.evidence}`) })),
        ...(screenAnalysis.verification || []).map((o) => ({ ts: o.timestamp, norm: normalizeForMatch(`${o.title} ${o.evidence} ${o.value_seen}`) })),
        ...screenAnalysis.key_facts_seen.map((o) => ({ ts: o.timestamp, norm: normalizeForMatch(`${o.fact} ${o.value}`) })),
      ]
    : [];
  return evidence
    .filter((e) => e && typeof e.text === "string" && e.text.trim())
    .slice(0, 10)
    .map((e) => {
      const rawSpeaker = String(e.speaker || "").trim().toLowerCase();
      const speaker = rawSpeaker === "agent" ? "Agent" : rawSpeaker === "customer" ? "Customer" : rawSpeaker === "screen" ? "Screen" : "Unknown";
      const text = e.text.trim().slice(0, 1000);
      if (speaker === "Screen") {
        const ts = (/(\d{1,2}:\d{2})/.exec(text) || [])[1] || null;
        const norm = normalizeForMatch(text.replace(/\d{1,2}:\d{2}/g, ""));
        const words = norm.split(" ").filter((w) => w.length > 3);
        const match = screenItems.find((it) => (ts && it.ts === ts) || (words.length && words.filter((w) => it.norm.includes(w)).length >= Math.min(3, Math.ceil(words.length / 2))));
        return { speaker, source: "screen", text, verified: Boolean(match), transcript_index: null, offset_seconds: null, timestamp: ts };
      }
      const norm = normalizeForMatch(text);
      const probe = norm.slice(0, 40);
      const match = lines.find((l) => l.speaker === speaker && probe && (l.norm.includes(probe) || (norm.includes(l.norm) && l.norm.length > 10)));
      return { speaker, source: "transcript", text, verified: Boolean(match), transcript_index: match ? match.index : null, offset_seconds: match ? match.offset_seconds : null };
    });
}

/**
 * Validates the model output against the rubric and computes every total on the
 * server: per-parameter clamping, group totals, NA handling, ZTP and pass/fail.
 */
export function scoreEvaluation(raw, process, transcript, screenAnalysis = null) {
  const rubric = process.rubric || [];
  const scoring = process.scoring || {};
  const excludeNa = scoring.exclude_na_from_denominator !== false;
  const passingPercentage = Number.isFinite(Number(scoring.passing_percentage)) ? Number(scoring.passing_percentage) : 80;
  const ztpFailScore = Number.isFinite(Number(scoring.ztp_fail_score)) ? Number(scoring.ztp_fail_score) : 0;

  const byId = new Map();
  for (const p of Array.isArray(raw?.parameters) ? raw.parameters : []) {
    if (p && p.id) byId.set(String(p.id).trim().toUpperCase(), p);
  }

  const missing = [];
  const parameters = rubric.map((r) => {
    const maxMarks = Math.max(0, Number(r.max_marks) || 0);
    const base = { id: r.id, group: r.group || "General", parameter: r.parameter, evidence_source: r.evidence_source || "transcript", zero_tolerance: Boolean(r.zero_tolerance), max_marks: maxMarks };
    const m = byId.get(String(r.id).toUpperCase());
    if (!m) {
      missing.push(r.id);
      return { ...base, status: "NA", marks: 0, reason: "The evaluator did not return an assessment for this parameter; marked NA.", evidence: [], model_missing: true };
    }
    let status = String(m.status || "").trim().toUpperCase();
    if (!VALID_STATUS.has(status)) status = "NC";
    let marks = Math.round(Number(m.marks));
    if (!Number.isFinite(marks)) marks = 0;
    marks = Math.min(maxMarks, Math.max(0, marks));
    if (status === "NA") marks = 0;
    return { ...base, status, marks, reason: String(m.reason || "").trim().slice(0, 2000) || "No reason provided.", evidence: verifyEvidence(m.evidence, transcript, screenAnalysis) };
  });

  const groups = rubricGroups(rubric).map((g) => {
    const rows = parameters.filter((p) => p.group === g.group);
    const applicable = rows.filter((p) => p.status !== "NA").reduce((s, p) => s + p.max_marks, 0);
    const marks = rows.reduce((s, p) => s + p.marks, 0);
    return {
      group: g.group,
      marks,
      max_marks: g.max_marks,
      applicable_marks: applicable,
      percentage: applicable > 0 ? Math.round((marks / applicable) * 1000) / 10 : null,
      counts: { C: rows.filter((p) => p.status === "C").length, NC: rows.filter((p) => p.status === "NC").length, NA: rows.filter((p) => p.status === "NA").length },
    };
  });

  const totalMarks = parameters.reduce((s, p) => s + p.marks, 0);
  const maximumMarks = parameters.reduce((s, p) => s + p.max_marks, 0);
  const applicableMarks = parameters.filter((p) => p.status !== "NA").reduce((s, p) => s + p.max_marks, 0);
  const denominator = excludeNa ? applicableMarks : maximumMarks;
  const earnedPercentage = denominator > 0 ? Math.round((totalMarks / denominator) * 1000) / 10 : 0;
  const rawPercentage = maximumMarks > 0 ? Math.round((totalMarks / maximumMarks) * 1000) / 10 : 0;
  const ztpFailures = parameters.filter((p) => p.zero_tolerance && p.status === "NC");
  const ztpFailed = ztpFailures.length > 0;
  const percentage = ztpFailed ? Math.min(earnedPercentage, ztpFailScore) : earnedPercentage;

  return {
    parameters,
    groups,
    total_marks: totalMarks,
    maximum_marks: maximumMarks,
    applicable_marks: applicableMarks,
    na_marks: maximumMarks - applicableMarks,
    percentage,
    earned_percentage: earnedPercentage,
    raw_percentage: rawPercentage,
    percentage_basis: excludeNa ? "applicable_marks" : "maximum_marks",
    passing_percentage: passingPercentage,
    ztp_failed: ztpFailed,
    ztp_failures: ztpFailures.map((p) => ({ id: p.id, parameter: p.parameter })),
    passed: !ztpFailed && percentage >= passingPercentage,
    counts: { C: parameters.filter((p) => p.status === "C").length, NC: parameters.filter((p) => p.status === "NC").length, NA: parameters.filter((p) => p.status === "NA").length },
    resolution_achieved: Boolean(raw?.resolution_achieved),
    overall_feedback: String(raw?.overall_feedback || "").slice(0, 4000),
    strengths: Array.isArray(raw?.strengths) ? raw.strengths.map(String).slice(0, 10) : [],
    improvements: Array.isArray(raw?.improvements) ? raw.improvements.map(String).slice(0, 10) : [],
    missing_parameters: missing,
  };
}

async function loadAudioPart(sessionId, onStage) {
  const buffer = await db.getRecordingBuffer(sessionId, "audio").catch((err) => {
    console.warn(`[evaluation] audio load failed for ${sessionId}:`, err.message);
    return null;
  });
  if (!buffer || buffer.length < 2048) return { part: null, reason: !buffer ? "no_audio_file" : "audio_too_short", cleanup: async () => {} };
  if (buffer.length <= MAX_INLINE_AUDIO_BYTES) {
    return { part: { inlineData: { mimeType: "audio/webm", data: buffer.toString("base64") } }, reason: null, size: buffer.length, cleanup: async () => {} };
  }
  // Large audio -> Gemini Files API (no inline limit)
  try {
    if (onStage) onStage("uploading_audio");
    const uploaded = await uploadMediaToGemini({ buffer, mimeType: "audio/webm", displayName: `${sessionId}-audio` });
    return { part: { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } }, reason: null, size: buffer.length, cleanup: uploaded.cleanup };
  } catch (err) {
    console.warn(`[evaluation] audio upload failed for ${sessionId}:`, err.message);
    return { part: null, reason: `audio_upload_failed: ${err.message}`.slice(0, 200), cleanup: async () => {} };
  }
}

/** Runs the full evaluation for a session and returns the scorecard. */
export async function evaluateSession({ session, process, transcript, recordingInfo, screenAnalysis = null, onStage = null }) {
  const cfg = getGeminiConfig();
  const audio = await loadAudioPart(session.session_id, onStage);
  if (onStage) onStage("scoring");

  // With audio first (if available), then transcript-only; each retried once if the model omitted parameters.
  const attempts = [];
  if (audio.part) attempts.push({ withAudio: true }, { withAudio: true, retry: true });
  attempts.push({ withAudio: false }, { withAudio: false, retry: true });

  let lastError = null;
  let audioFailed = false;
  for (const attempt of attempts) {
    if (attempt.withAudio && audioFailed) continue;
    const prompt = buildEvaluationPrompt({ process, session, transcript, recordingInfo, audioAttached: attempt.withAudio, screenAnalysis });
    const parts = [{ text: prompt }];
    if (attempt.withAudio) parts.push({ text: "CONVERSATION AUDIO (microphone + AI customer, mixed):" }, audio.part);
    try {
      const { data, usage } = await generateStructuredJson({ model: cfg.evaluationModel, parts, schema: EVALUATION_SCHEMA });
      const scored = scoreEvaluation(data, process, transcript, screenAnalysis);
      if (scored.missing_parameters.length > 0 && !attempt.retry) {
        console.warn(`[evaluation] model omitted ${scored.missing_parameters.join(", ")} for ${session.session_id}; retrying once`);
        continue;
      }
      await audio.cleanup();
      return {
        ...scored,
        model: cfg.evaluationModel,
        screen_analysis: screenAnalysis || null,
        evidence_sources: {
          transcript: transcript.length > 0,
          audio: attempt.withAudio,
          audio_skipped_reason: attempt.withAudio ? null : audio.reason || (audioFailed ? "audio_attempt_failed" : null),
          screen_video_analyzed: Boolean(screenAnalysis?.analyzed),
          screen_analysis_error: recordingInfo.screen_analysis_error || null,
          screen_actions_observed: screenAnalysis?.counts?.observed ?? null,
          screen_portal_verdict: screenAnalysis?.portal_verdict || null,
          screen_crm_verdict: screenAnalysis?.crm_verdict || null,
          screen_consistency: screenAnalysis?.cross_check?.consistency || null,
          screen_recording_captured: Boolean(recordingInfo.screen),
        },
        usage,
      };
    } catch (err) {
      lastError = err;
      console.error(`[evaluation] attempt (audio=${attempt.withAudio}) failed for ${session.session_id}:`, err.message);
      if (attempt.withAudio) audioFailed = true;
      else if (attempt.retry) break;
      else if (/not configured|API key|PERMISSION_DENIED|403|401/i.test(String(err.message))) break;
    }
  }
  await audio.cleanup();
  throw lastError || new Error("Evaluation failed");
}

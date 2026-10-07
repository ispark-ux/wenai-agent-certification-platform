import { db } from "./db";
import { httpError } from "./http";
import { normalizeRubric, rubricTotal, rubricGroups, VOICES } from "@/lib/rubric";
import { parseEmailList } from "./email";
import { nowIso } from "./storage";

const DEFAULT_AGENT_INSTRUCTIONS = [
  "You will interact with an AI customer. Please behave exactly as you would in a real customer call.",
  "The customer speaks first. Listen carefully and respond naturally.",
  "Use your normal tools (order portal / CRM) on the shared screen exactly as you would on a live call.",
  "Click END CERTIFICATION only after you have closed the call properly.",
];

export function slugifyProcessId(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function toLines(value, fallback) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
  if (typeof value === "string") return value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).slice(0, 20);
  return fallback;
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Validates / normalises a process coming from the admin form or a JSON file.
 * Accepts both nested (customer_profile.name) and flat (customer_name) fields.
 */
export function normalizeProcess(input, existing = null) {
  const src = input || {};
  const name = String(src.process_name || src.name || existing?.process_name || "").trim().slice(0, 120);
  if (!name) throw httpError("Process name is required", 400);

  const processId = existing ? existing.process_id : slugifyProcessId(src.process_id || name);
  if (!/^[A-Z0-9_]{2,40}$/.test(processId)) throw httpError("Process ID must be 2-40 characters using A-Z, 0-9 or _", 400);

  const aiPrompt = String(src.ai_prompt ?? existing?.ai_prompt ?? "").trim().slice(0, 20000);
  const scenarioIn = { ...(existing?.scenario || {}), ...(src.scenario || {}) };
  if (!aiPrompt && !scenarioIn.hidden_information) throw httpError("AI prompt is required - describe the customer and scenario the AI should role-play.", 400);

  const customerName = String(src.customer_name || src.customer_profile?.name || existing?.customer_profile?.name || "Customer").trim().slice(0, 80);
  const scenarioTitle = String(src.scenario_title || src.scenario?.title || existing?.scenario?.title || "Customer call").trim().slice(0, 200);
  const openingLine = String(src.opening_line || src.scenario?.opening_line || existing?.scenario?.opening_line || "").trim().slice(0, 500);
  if (!openingLine) throw httpError("Opening line is required - the first sentence the AI customer says.", 400);

  const liveIn = { ...(existing?.live_settings || {}), ...(src.live_settings || {}) };
  if (src.voice_name) liveIn.voice_name = src.voice_name;
  if (src.max_duration_minutes !== undefined) liveIn.max_duration_minutes = src.max_duration_minutes;
  const scoringIn = { ...(existing?.scoring || {}), ...(src.scoring || {}) };
  if (src.passing_percentage !== undefined) scoringIn.passing_percentage = src.passing_percentage;

  const now = nowIso();
  return {
    ...(existing || {}),
    process_id: processId,
    process_name: name,
    tagline: String(src.tagline ?? existing?.tagline ?? "").trim().slice(0, 200),
    description: String(src.description ?? existing?.description ?? "").trim().slice(0, 2000),
    language: String(src.language ?? existing?.language ?? "Hindi/Hinglish").trim().slice(0, 60) || "Hindi/Hinglish",
    active: src.active === undefined ? existing?.active !== false : Boolean(src.active),
    customer_profile: { ...(existing?.customer_profile || {}), ...(src.customer_profile || {}), name: customerName },
    scenario: { ...scenarioIn, title: scenarioTitle, opening_line: openingLine },
    ai_prompt: aiPrompt,
    evaluator_notes: String(src.evaluator_notes ?? existing?.evaluator_notes ?? "").trim().slice(0, 10000),
    conversation_rules: { start_with_customer: true, customer_must_start_conversation: true, short_responses: true, do_not_coach_agent: true, do_not_reveal_hidden_information: true, ...(existing?.conversation_rules || {}), ...(src.conversation_rules || {}) },
    live_settings: {
      voice_name: VOICES.includes(liveIn.voice_name) ? liveIn.voice_name : "Puck",
      temperature: num(liveIn.temperature, 0.8, 0, 2),
      max_duration_minutes: Math.round(num(liveIn.max_duration_minutes, 15, 1, 60)),
      setup_timeout_seconds: Math.round(num(liveIn.setup_timeout_seconds, 15, 5, 60)),
      half_duplex: liveIn.half_duplex !== false,
      end_of_speech_sensitivity: liveIn.end_of_speech_sensitivity === "LOW" ? "LOW" : "HIGH",
      start_of_speech_sensitivity: liveIn.start_of_speech_sensitivity === "LOW" ? "LOW" : "HIGH",
      silence_duration_ms: Math.round(num(liveIn.silence_duration_ms, 800, 200, 3000)),
      prefix_padding_ms: Math.round(num(liveIn.prefix_padding_ms, 300, 0, 1000)),
    },
    agent_instructions: toLines(src.agent_instructions, existing?.agent_instructions || DEFAULT_AGENT_INSTRUCTIONS),
    scoring: {
      passing_percentage: num(scoringIn.passing_percentage, 80, 0, 100),
      exclude_na_from_denominator: scoringIn.exclude_na_from_denominator !== false,
      ztp_fail_score: num(scoringIn.ztp_fail_score, 0, 0, 100),
    },
    notification_emails: parseEmailList(src.notification_emails ?? existing?.notification_emails ?? []),
    recertification: {
      enabled: src.recertification?.enabled === undefined ? existing?.recertification?.enabled !== false : Boolean(src.recertification.enabled),
      max_attempts: Math.round(num(src.recertification?.max_attempts ?? existing?.recertification?.max_attempts, 3, 1, 20)),
      cooldown_hours: Math.round(num(src.recertification?.cooldown_hours ?? existing?.recertification?.cooldown_hours, 0, 0, 720)),
    },
    expected_portal_actions: toLines(src.expected_portal_actions, existing?.expected_portal_actions || []),
    expected_crm_actions: toLines(src.expected_crm_actions, existing?.expected_crm_actions || []),
    screen_analysis: {
      enabled: src.screen_analysis?.enabled === undefined ? existing?.screen_analysis?.enabled !== false : Boolean(src.screen_analysis.enabled),
      fps: num(src.screen_analysis?.fps ?? existing?.screen_analysis?.fps, 1, 0.2, 5),
    },
    rubric: normalizeRubric(src.rubric || existing?.rubric),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

export async function listProcesses({ includeInactive = false } = {}) {
  await db.ensureSeed();
  const all = await db.listProcesses();
  return all.filter((p) => includeInactive || p.active !== false).sort((a, b) => String(a.process_name || a.process_id).localeCompare(String(b.process_name || b.process_id)));
}

export async function getProcess(processId) {
  if (!processId) return null;
  await db.ensureSeed();
  return db.getProcess(processId);
}

export function rubricMaxTotal(process) {
  return rubricTotal(process?.rubric || []);
}

/** Agent-facing view: no AI prompt, no evaluator notes, no hidden information, no rubric weights. */
export function publicProcessView(process) {
  if (!process) return null;
  return {
    process_id: process.process_id,
    process_name: process.process_name,
    tagline: process.tagline || "",
    description: process.description || "",
    language: process.language || "",
    active: process.active !== false,
    scenario: { title: process.scenario?.title || "" },
    customer_name: process.customer_profile?.name || "Customer",
    agent_instructions: process.agent_instructions || DEFAULT_AGENT_INSTRUCTIONS,
    live_settings: { max_duration_minutes: process.live_settings?.max_duration_minutes || 15, setup_timeout_seconds: process.live_settings?.setup_timeout_seconds || 15 },
    rubric_parameter_count: (process.rubric || []).length,
    maximum_marks: rubricMaxTotal(process),
  };
}

/** Admin view: full configuration plus derived totals. */
export function adminProcessView(process) {
  if (!process) return null;
  return {
    ...process,
    maximum_marks: rubricMaxTotal(process),
    groups: rubricGroups(process.rubric || []).map((g) => ({ group: g.group, max_marks: g.max_marks, count: g.parameters.length })),
  };
}

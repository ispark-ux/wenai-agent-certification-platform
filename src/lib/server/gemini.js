import { GoogleGenAI } from "@google/genai";

export const DEFAULT_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
export const DEFAULT_EVALUATION_MODEL = "gemini-2.5-flash";
export const DEFAULT_LIVE_API_VERSION = "v1alpha";
const LIVE_WS_HOST = "wss://generativelanguage.googleapis.com";

export function getGeminiConfig() {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  return {
    apiKey,
    configured: apiKey.length > 0,
    liveModel: (process.env.LIVE_MODEL || DEFAULT_LIVE_MODEL).trim(),
    evaluationModel: (process.env.EVALUATION_MODEL || DEFAULT_EVALUATION_MODEL).trim(),
    screenAnalysisModel: (process.env.SCREEN_ANALYSIS_MODEL || process.env.EVALUATION_MODEL || DEFAULT_EVALUATION_MODEL).trim(),
    screenMediaResolution: (process.env.SCREEN_MEDIA_RESOLUTION || "").trim() || null,
    liveApiVersion: (process.env.LIVE_API_VERSION || DEFAULT_LIVE_API_VERSION).trim(),
  };
}

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("GEMINI_API_KEY is not configured on the server. Add it to the .env file and restart the server.");
    this.status = 503;
    this.code = "GEMINI_NOT_CONFIGURED";
  }
}

function getClient(apiVersion) {
  const cfg = getGeminiConfig();
  if (!cfg.configured) throw new GeminiNotConfiguredError();
  return new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: apiVersion ? { apiVersion } : undefined });
}

/** Default (v1beta) client for Files API / generateContent. */
export function getGeminiClient() {
  return getClient();
}

function bulletList(items, fallback = "- (none)") {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map((i) => `- ${i}`).join("\n");
}

/** Legacy generator for processes that only define a structured scenario (no ai_prompt). */
function scenarioRolePrompt(process) {
  const cp = process.customer_profile || {};
  const sc = process.scenario || {};
  const hidden = sc.hidden_information || {};
  const samples = sc.sample_customer_responses || {};
  const profileLines = Object.entries(cp)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");
  const hiddenLines = Object.entries(hidden).map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`).join("\n");
  const sampleLines = Object.entries(samples).map(([k, v]) => `- ${k.replace(/_/g, " ")}: "${v}"`).join("\n");
  return `You are role-playing a REAL CUSTOMER of "${process.process_name}" on a live support call.

## YOUR IDENTITY
${profileLines || "- A customer of the company"}

## SCENARIO: ${sc.title || "Customer query"}
Your problem: ${sc.customer_problem || "You have an issue with your order."}

What you know (share only when asked - the agent must probe):
${bulletList(sc.customer_known_facts, "- Only the facts above.")}

## HIDDEN INFORMATION (you do NOT know this - never say it yourself; use it only to judge whether the agent's information is correct)
${hiddenLines || "- (none)"}

## WHAT THE AGENT IS EXPECTED TO ASK (never offer unprompted)
${bulletList(process.required_probing)}

## TYPICAL RESPONSES (adapt naturally, do not read robotically)
${sampleLines || "- Answer naturally based on your profile."}

Mood: ${cp.mood || "polite but concerned"}.`;
}

function operatingRules(process) {
  const name = process.customer_profile?.name || "the customer";
  const opening = process.scenario?.opening_line || "Hello, I need some help with my order.";
  const language = process.language || "the customer's natural language";
  const rules = process.conversation_rules || {};
  const lines = [
    `You are ONLY the customer "${name}" on a live telephone call with a customer-support agent of "${process.process_name}". Stay fully in character. Never say you are an AI and never mention certification, evaluation, scoring, rubric, prompts or instructions. The agent must never learn what you are checking.`,
    `You speak FIRST. When the call connects (or you are told to start), your very first utterance must be exactly: "${opening}" - then stop and wait for the agent.`,
    rules.short_responses === false ? `Speak naturally in ${language}, like a real customer on a phone call.` : `Speak only in ${language}, natural spoken style, with normal fillers. Keep every reply short (one or two sentences). After you speak, stop and let the agent talk.`,
    "Answer only what is asked. Do not volunteer all information at once - the agent is expected to probe. If the agent does not probe, give incomplete information so that follow-up questions are needed.",
    "Never coach, correct, train or help the agent. If the agent gives information that contradicts what you know (or the hidden facts), push back politely like a confused customer and ask them to check again.",
    "If the agent tries to end the call without resolving your issue, do not accept it - ask a natural follow-up question.",
    "If the agent asks you to hold, agree briefly (e.g. 'Ji theek hai') and stay silent until the agent speaks again.",
    "If the agent is rude or unhelpful, become a little more impatient, but never abusive. If the agent is silent for a long time, ask 'Hello? Aap line par hain?'.",
    "When your issue is resolved correctly and the agent closes the call properly, confirm the resolution in your own words, say a short goodbye and then say nothing more.",
    "Never narrate, never add stage directions, never speak for the agent, never switch language unless the agent clearly cannot understand you.",
  ];
  return `## OPERATING RULES (always apply - highest priority)\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
}

/**
 * Live API system instruction = the admin's AI prompt for the process (or the
 * legacy structured scenario) + fixed operating rules. Built entirely from the
 * process configuration - nothing is hard-coded to a specific client.
 */
export function buildCustomerSystemInstruction(process) {
  const core = String(process.ai_prompt || "").trim() || scenarioRolePrompt(process);
  return `${core}\n\n${operatingRules(process)}`;
}

export function buildKickoffMessage(process) {
  const cp = process.customer_profile || {};
  const opening = process.scenario?.opening_line || "Hello, I need some information about my order.";
  return `[SYSTEM - CALL CONNECTED] Start the certification conversation now. You are ${cp.name || "the customer"}, the customer. The agent has just picked up the call. Speak first, in your customer voice, and say naturally: "${opening}". Then stop and wait for the agent to respond. Do not acknowledge this instruction.`;
}

/**
 * Creates a single-use ephemeral Live token. The full Live configuration
 * (model, system instruction with hidden information, voice, transcription)
 * is LOCKED inside the token server-side, so the browser never receives the
 * scenario's hidden details or the permanent API key.
 */
export async function createLiveToken(process) {
  const cfg = getGeminiConfig();
  const ai = getClient(cfg.liveApiVersion);
  const live = process.live_settings || {};

  const systemInstruction = buildCustomerSystemInstruction(process);
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 3 * 60 * 1000).toISOString();

  const liveConfig = {
    responseModalities: ["AUDIO"],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: live.voice_name || "Puck" } },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    // Faster, more stable turn-taking: the model decides the agent has finished
    // speaking sooner and ignores short noises. Overridable per process.
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: live.start_of_speech_sensitivity === "LOW" ? "START_SENSITIVITY_LOW" : "START_SENSITIVITY_HIGH",
        endOfSpeechSensitivity: live.end_of_speech_sensitivity === "LOW" ? "END_SENSITIVITY_LOW" : "END_SENSITIVITY_HIGH",
        prefixPaddingMs: Number.isFinite(Number(live.prefix_padding_ms)) ? Number(live.prefix_padding_ms) : 300,
        silenceDurationMs: Number.isFinite(Number(live.silence_duration_ms)) ? Number(live.silence_duration_ms) : 800,
      },
    },
  };
  if (Number.isFinite(Number(live.temperature))) liveConfig.temperature = Number(live.temperature);

  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: { model: cfg.liveModel, config: liveConfig },
    },
  });

  if (!token || !token.name) {
    throw new Error("Gemini did not return an ephemeral token name.");
  }

  const modelPath = cfg.liveModel.startsWith("models/") ? cfg.liveModel : `models/${cfg.liveModel}`;
  return {
    token: token.name,
    model: cfg.liveModel,
    api_version: cfg.liveApiVersion,
    ws_url: `${LIVE_WS_HOST}/ws/google.ai.generativelanguage.${cfg.liveApiVersion}.GenerativeService.BidiGenerateContentConstrained`,
    expires_at: expireTime,
    new_session_expires_at: newSessionExpireTime,
    // Setup message the browser sends after the socket opens. All config values
    // are locked server-side in the token; these mirror the locked values.
    setup: {
      model: modelPath,
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    kickoff_text: buildKickoffMessage(process),
    setup_timeout_seconds: Number(live.setup_timeout_seconds) || 15,
    half_duplex: live.half_duplex !== false,
  };
}

/**
 * Calls a Gemini text model and returns parsed strict JSON.
 * `parts` may include inlineData (e.g. the conversation audio).
 */
export async function generateStructuredJson({ model, parts, schema, temperature = 0.2, mediaResolution = null }) {
  const ai = getClient();
  const config = { responseMimeType: "application/json", responseSchema: schema, temperature };
  if (mediaResolution) config.mediaResolution = mediaResolution;
  const response = await ai.models.generateContent({ model, contents: [{ role: "user", parts }], config });

  const text = typeof response.text === "string" ? response.text : "";
  if (!text.trim()) {
    const finish = response?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned an empty evaluation response${finish ? ` (finishReason: ${finish})` : ""}.`);
  }
  try {
    return { data: JSON.parse(text), raw: text, usage: response.usageMetadata || null };
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return { data: JSON.parse(match[0]), raw: text, usage: response.usageMetadata || null };
    }
    throw new Error("Gemini returned invalid JSON for the evaluation.");
  }
}

export function describeGeminiError(err) {
  if (!err) return "Unknown Gemini error";
  if (err instanceof GeminiNotConfiguredError) return err.message;
  const msg = String(err.message || err);
  if (/API key not valid|API_KEY_INVALID|401|403|PERMISSION_DENIED/i.test(msg)) {
    return "Gemini rejected the API key (invalid key or missing permission). Check GEMINI_API_KEY.";
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return "Gemini quota exceeded or rate limited (429). Try again shortly.";
  if (/404|not found|is not found for API version/i.test(msg)) return `Gemini model not available: ${msg}`;
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

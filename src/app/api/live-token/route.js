import { getSession, updateSession } from "@/lib/server/sessions";
import { getProcess } from "@/lib/server/processes";
import { createLiveToken, describeGeminiError, getGeminiConfig, GeminiNotConfiguredError } from "@/lib/server/gemini";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";
import { nowIso } from "@/lib/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/live-token  { session_id }
 * Creates a single-use ephemeral Gemini Live token. The permanent API key and the
 * scenario's hidden information stay on the server (locked inside the token).
 */
export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const sessionId = String(body.session_id || "").trim();
    if (!sessionId) throw httpError("session_id is required", 400);

    const session = await getSession(sessionId);
    if (!session) throw httpError(`Certification '${sessionId}' not found`, 404);
    if (session.status === "completed") throw httpError("This certification is already completed.", 409);

    const process_ = await getProcess(session.process_id);
    if (!process_) throw httpError(`Process '${session.process_id}' not found`, 404);
    if (process_.active === false) throw httpError(`Process '${process_.process_name}' is inactive.`, 409);
    if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();

    let tokenInfo;
    try {
      tokenInfo = await createLiveToken(process_);
    } catch (err) {
      const message = describeGeminiError(err);
      console.error(`[live-token] Failed for ${sessionId}:`, message);
      throw httpError(`Could not create Gemini Live token: ${message}`, err?.status || 502, "LIVE_TOKEN_FAILED");
    }

    await updateSession(sessionId, (s) => {
      s.live = { model: tokenInfo.model, api_version: tokenInfo.api_version, token_issued_at: nowIso(), token_count: (s.live?.token_count || 0) + 1 };
      return s;
    });
    // Never log the token itself.
    console.log(`[live-token] Issued ephemeral token for ${sessionId} (model=${tokenInfo.model})`);
    return json(tokenInfo);
  } catch (err) {
    return errorResponse(err);
  }
}

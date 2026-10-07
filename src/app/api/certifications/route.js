import { listSessions, sessionSummary } from "@/lib/server/sessions";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/certifications -> recent certifications (newest first) */
export async function GET(request) {
  try {
    const limit = Math.min(500, Math.max(1, Number(new URL(request.url).searchParams.get("limit")) || 200));
    const sessions = await listSessions({ limit });
    return json({ certifications: sessions.map(sessionSummary) });
  } catch (err) {
    return errorResponse(err);
  }
}

import { getSession, getResult } from "@/lib/server/sessions";
import { isValidSessionId } from "@/lib/server/storage";
import { errorResponse, json, httpError } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/certifications/{id} -> session (+ result when completed) */
export async function GET(request, context) {
  try {
    const { sessionId } = await context.params;
    if (!isValidSessionId(sessionId)) throw httpError("Invalid session id", 400);
    const session = await getSession(sessionId);
    if (!session) throw httpError(`Certification '${sessionId}' not found`, 404);
    const result = session.status === "completed" ? await getResult(sessionId) : null;
    return json({ session, result });
  } catch (err) {
    return errorResponse(err);
  }
}

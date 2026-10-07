import { db } from "@/lib/server/db";
import { createCertification } from "@/lib/server/certifications";
import { errorResponse, json, httpError, readJsonBody, publicBaseUrl } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/agents/{id}/invite  { process_id?, send_email? } -> creates a certification link for the agent and emails it */
export async function POST(request, context) {
  try {
    const { agentId } = await context.params;
    const agent = await db.getAgent(agentId);
    if (!agent) throw httpError("Agent not found", 404);
    const body = await readJsonBody(request);
    const processId = body.process_id || agent.process_id;
    if (!processId) throw httpError("Select a process for this agent first.", 400);
    const result = await createCertification({ processId, agentId: agent.id, sendEmail: body.send_email !== false, baseUrl: publicBaseUrl(request) });
    return json({ session: result.session, certification_url: result.url, email: result.email }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

import { createCertification } from "@/lib/server/certifications";
import { errorResponse, json, httpError, readJsonBody, publicBaseUrl } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/certifications/create  { process_id, agent_id?, agent_name?, agent_email?, send_email? } */
export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    if (!body.process_id) throw httpError("process_id is required", 400);
    const result = await createCertification({
      processId: body.process_id,
      agentId: body.agent_id || null,
      agentName: body.agent_name || "",
      agentEmail: body.agent_email || "",
      sendEmail: Boolean(body.send_email),
      baseUrl: publicBaseUrl(request),
    });
    return json({ session: result.session, certification_path: `/certification/${result.session.session_id}`, certification_url: result.url, email: result.email }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

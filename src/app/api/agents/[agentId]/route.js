import { db } from "@/lib/server/db";
import { getProcess } from "@/lib/server/processes";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";
import { normalizeAgentInput } from "../route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request, context) {
  try {
    const { agentId } = await context.params;
    const existing = await db.getAgent(agentId);
    if (!existing) throw httpError("Agent not found", 404);
    const body = await readJsonBody(request);
    const agent = normalizeAgentInput(body, existing);
    if (agent.process_id && !(await getProcess(agent.process_id))) throw httpError(`Process '${agent.process_id}' not found`, 404);
    await db.saveAgent(agent);
    return json({ agent });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request, context) {
  try {
    const { agentId } = await context.params;
    const removed = await db.deleteAgent(agentId);
    if (!removed) throw httpError("Agent not found", 404);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

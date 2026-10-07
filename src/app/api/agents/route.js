import { randomUUID } from "crypto";
import { db } from "@/lib/server/db";
import { getProcess } from "@/lib/server/processes";
import { parseEmailList } from "@/lib/server/email";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";
import { nowIso } from "@/lib/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function normalizeAgentInput(body, existing = null) {
  const name = String(body.name ?? existing?.name ?? "").trim().slice(0, 120);
  if (!name) throw httpError("Agent name is required", 400);
  const emailRaw = body.email === undefined ? existing?.email : body.email;
  const email = emailRaw ? parseEmailList(emailRaw)[0] || null : null;
  if (emailRaw && !email) throw httpError("Please enter a valid email address", 400);
  return {
    id: existing?.id || randomUUID(),
    name,
    email,
    employee_id: String(body.employee_id ?? existing?.employee_id ?? "").trim().slice(0, 60) || null,
    process_id: body.process_id === undefined ? existing?.process_id || null : body.process_id || null,
    active: body.active === undefined ? existing?.active !== false : Boolean(body.active),
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

/** GET /api/agents?process_id= */
export async function GET(request) {
  try {
    const processId = new URL(request.url).searchParams.get("process_id") || undefined;
    const agents = await db.listAgents({ process_id: processId });
    return json({ agents });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/agents  { name, email, employee_id, process_id } */
export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const agent = normalizeAgentInput(body, null);
    if (agent.process_id && !(await getProcess(agent.process_id))) throw httpError(`Process '${agent.process_id}' not found`, 404);
    if (agent.email) {
      const dup = (await db.listAgents({ process_id: agent.process_id || undefined })).find((a) => a.email === agent.email && (a.process_id || null) === (agent.process_id || null));
      if (dup) throw httpError(`An agent with email ${agent.email} already exists in this process.`, 409);
    }
    await db.saveAgent(agent);
    return json({ agent }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

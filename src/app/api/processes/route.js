import { listProcesses, getProcess, normalizeProcess, publicProcessView, adminProcessView } from "@/lib/server/processes";
import { db } from "@/lib/server/db";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/processes            -> active processes (agent-safe view)
 *  GET /api/processes?view=admin -> all processes with full configuration */
export async function GET(request) {
  try {
    const admin = new URL(request.url).searchParams.get("view") === "admin";
    const processes = await listProcesses({ includeInactive: admin });
    return json({ processes: processes.map((p) => (admin ? adminProcessView(p) : publicProcessView(p))) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/processes -> create a process (admin) */
export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const process_ = normalizeProcess(body, null);
    if (await getProcess(process_.process_id)) throw httpError(`Process ID '${process_.process_id}' already exists. Choose a different name/ID.`, 409);
    await db.saveProcess(process_);
    return json({ process: adminProcessView(process_) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

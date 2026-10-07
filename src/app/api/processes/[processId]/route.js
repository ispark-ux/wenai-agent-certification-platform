import { getProcess, normalizeProcess, publicProcessView, adminProcessView } from "@/lib/server/processes";
import { db } from "@/lib/server/db";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request, context) {
  try {
    const { processId } = await context.params;
    const admin = new URL(request.url).searchParams.get("view") === "admin";
    const process_ = await getProcess(processId);
    if (!process_) throw httpError(`Process '${processId}' not found`, 404);
    return json({ process: admin ? adminProcessView(process_) : publicProcessView(process_) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/processes/{id} -> update (admin) */
export async function PUT(request, context) {
  try {
    const { processId } = await context.params;
    const existing = await getProcess(processId);
    if (!existing) throw httpError(`Process '${processId}' not found`, 404);
    const body = await readJsonBody(request);
    const updated = normalizeProcess(body, existing);
    await db.saveProcess(updated);
    return json({ process: adminProcessView(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/processes/{id} -> delete (admin). Past certifications keep their copy of the process name. */
export async function DELETE(request, context) {
  try {
    const { processId } = await context.params;
    const existing = await getProcess(processId);
    if (!existing) throw httpError(`Process '${processId}' not found`, 404);
    await db.deleteProcess(existing.process_id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

import { db, dbInfo } from "@/lib/server/db";
import { listProcesses } from "@/lib/server/processes";
import { getGeminiConfig } from "@/lib/server/gemini";
import { getEmailSettings } from "@/lib/server/certifications";
import { emailConfigured } from "@/lib/server/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const gemini = getGeminiConfig();
  const info = dbInfo();
  let databaseOk = true;
  let databaseError = null;
  let processes = [];
  let email = false;
  try {
    await db.ping();
    processes = (await listProcesses({ includeInactive: true })).map((p) => p.process_id);
    email = emailConfigured(await getEmailSettings());
  } catch (err) {
    databaseOk = false;
    databaseError = err.message;
  }
  return Response.json({
    ok: true,
    status: "ok",
    service: "AI Agent Certification Platform",
    database: info.mode,
    database_ok: databaseOk,
    database_error: databaseError,
    supabase_url: info.supabase_url,
    processes,
    gemini_configured: gemini.configured,
    live_model: gemini.liveModel,
    evaluation_model: gemini.evaluationModel,
    email_configured: email,
    time: new Date().toISOString(),
  });
}

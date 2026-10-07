import { getEmailSettings, saveEmailSettings } from "@/lib/server/certifications";
import { maskEmailSettings, emailConfigured } from "@/lib/server/email";
import { errorResponse, json, readJsonBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const settings = await getEmailSettings();
    return json({ settings: maskEmailSettings(settings), configured: emailConfigured(settings) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request) {
  try {
    const body = await readJsonBody(request);
    const saved = await saveEmailSettings(body);
    return json({ settings: maskEmailSettings(saved), configured: emailConfigured(saved) });
  } catch (err) {
    return errorResponse(err);
  }
}

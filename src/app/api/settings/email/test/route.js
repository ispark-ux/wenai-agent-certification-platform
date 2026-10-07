import { getEmailSettings } from "@/lib/server/certifications";
import { db } from "@/lib/server/db";
import { parseEmailList, renderTestEmail, sendMail } from "@/lib/server/email";
import { errorResponse, json, httpError, readJsonBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/settings/email/test { to } -> sends a test email with the SAVED settings */
export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const settings = await getEmailSettings();
    const to = parseEmailList(body.to || settings.notify_to);
    if (!to.length) throw httpError("Enter a recipient email address for the test.", 400);
    const { subject, html, text } = renderTestEmail(settings);
    try {
      const info = await sendMail(settings, { to, subject, html, text });
      await db.logEmail({ type: "test", to, cc: [], subject, status: "sent", message_id: info.message_id });
      return json({ ok: true, to, message_id: info.message_id });
    } catch (err) {
      await db.logEmail({ type: "test", to, cc: [], subject, status: "failed", error: err.message });
      throw httpError(`Test email failed: ${err.message}`, 502);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

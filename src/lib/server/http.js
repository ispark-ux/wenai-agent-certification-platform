/** Small helpers shared by all route handlers. */
export function json(data, init = {}) {
  return Response.json(data, init);
}

export function errorResponse(err, fallbackStatus = 500) {
  const status = Number(err?.status) || fallbackStatus;
  const message = err?.message || String(err) || "Unexpected error";
  if (status >= 500) console.error("[api]", err);
  return Response.json({ error: message, code: err?.code || undefined }, { status });
}

export function httpError(message, status = 400, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

export async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export function publicBaseUrl(request) {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

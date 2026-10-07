/** Thin fetch wrapper for the certification API. */
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function request(path, { method = "GET", body, headers = {}, rawBody = null, timeoutMs = 0 } = {}) {
  const init = { method, headers: { ...headers } };
  if (rawBody !== null) init.body = rawBody;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let timer = null;
  if (timeoutMs > 0 && typeof AbortController !== "undefined") {
    const controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err && err.name === "AbortError") throw new ApiError(`Request to ${path} timed out`, 0, null);
    throw new ApiError(`Network error while calling ${path}: ${err.message}`, 0, null);
  }
  if (timer) clearTimeout(timer);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) throw new ApiError((data && (data.error || data.message)) || `${res.status} ${res.statusText}`, res.status, data);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request("/api/health"),

  // processes
  listProcesses: (admin = false) => request(`/api/processes${admin ? "?view=admin" : ""}`),
  getProcess: (processId, admin = false) => request(`/api/processes/${enc(processId)}${admin ? "?view=admin" : ""}`),
  createProcess: (payload) => request("/api/processes", { method: "POST", body: payload }),
  updateProcess: (processId, payload) => request(`/api/processes/${enc(processId)}`, { method: "PUT", body: payload }),
  deleteProcess: (processId) => request(`/api/processes/${enc(processId)}`, { method: "DELETE" }),

  // agents
  listAgents: (processId) => request(`/api/agents${processId ? `?process_id=${enc(processId)}` : ""}`),
  createAgent: (payload) => request("/api/agents", { method: "POST", body: payload }),
  updateAgent: (agentId, payload) => request(`/api/agents/${enc(agentId)}`, { method: "PUT", body: payload }),
  deleteAgent: (agentId) => request(`/api/agents/${enc(agentId)}`, { method: "DELETE" }),
  inviteAgent: (agentId, payload = {}) => request(`/api/agents/${enc(agentId)}/invite`, { method: "POST", body: payload, timeoutMs: 60000 }),

  // certifications
  listCertifications: () => request("/api/certifications"),
  createCertification: (payload) => request("/api/certifications/create", { method: "POST", body: payload, timeoutMs: 60000 }),
  getCertification: (sessionId) => request(`/api/certifications/${enc(sessionId)}`),
  startCertification: (sessionId, payload) => request(`/api/certifications/${enc(sessionId)}/start`, { method: "POST", body: payload }),
  recertify: (sessionId, payload = {}) => request(`/api/certifications/${enc(sessionId)}/recertify`, { method: "POST", body: payload, timeoutMs: 60000 }),
  analytics: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/api/analytics${q ? `?${q}` : ""}`, { timeoutMs: 60000 });
  },
  resendInvite: (sessionId) => request(`/api/certifications/${enc(sessionId)}/resend-invite`, { method: "POST", body: {}, timeoutMs: 60000 }),
  resendResult: (sessionId) => request(`/api/certifications/${enc(sessionId)}/resend-result`, { method: "POST", body: {}, timeoutMs: 60000 }),

  // live flow
  getLiveToken: (sessionId) => request("/api/live-token", { method: "POST", body: { session_id: sessionId }, timeoutMs: 20000 }),
  saveTranscript: (sessionId, transcript, final = false) => request(`/api/certifications/${enc(sessionId)}/transcript`, { method: "POST", body: { transcript, final } }),
  uploadRecording: (sessionId, kind, blob, meta = {}) =>
    request(`/api/certifications/${enc(sessionId)}/upload-${kind === "audio" ? "audio" : "screen"}`, {
      method: "POST",
      rawBody: blob,
      headers: {
        "Content-Type": blob.type || (kind === "audio" ? "audio/webm" : "video/webm"),
        "x-recording-started-at": meta.startedAt || "",
        "x-recording-ended-at": meta.endedAt || "",
        "x-recording-duration": String(meta.durationSeconds ?? ""),
      },
    }),
  getUploadPlan: (sessionId, payload) => request(`/api/certifications/${enc(sessionId)}/upload-url`, { method: "POST", body: payload, timeoutMs: 30000 }),
  uploadChunk: (sessionId, params, blobSlice) =>
    request(
      `/api/certifications/${enc(sessionId)}/upload-chunk?upload_id=${enc(params.upload_id)}&kind=${enc(params.kind)}&offset=${params.offset}&index=${params.index}&total_size=${params.total_size}`,
      { method: "POST", rawBody: blobSlice, headers: { "Content-Type": "application/octet-stream" }, timeoutMs: 120000 }
    ),
  completeUpload: (sessionId, payload) => request(`/api/certifications/${enc(sessionId)}/upload-complete`, { method: "POST", body: payload, timeoutMs: 180000 }),
  endCertification: (sessionId, payload) => request(`/api/certifications/${enc(sessionId)}/end`, { method: "POST", body: payload }),
  evaluate: (sessionId, force = false) => request(`/api/certifications/${enc(sessionId)}/evaluate`, { method: "POST", body: { force }, timeoutMs: 60000 }),
  getResult: (sessionId) => request(`/api/certifications/${enc(sessionId)}/result`),
  recordingUrl: (sessionId, kind = "screen") => `/api/certifications/${enc(sessionId)}/recording?type=${kind}`,

  // settings
  getEmailSettings: () => request("/api/settings/email"),
  saveEmailSettings: (payload) => request("/api/settings/email", { method: "PUT", body: payload }),
  testEmail: (to) => request("/api/settings/email/test", { method: "POST", body: { to }, timeoutMs: 60000 }),
};

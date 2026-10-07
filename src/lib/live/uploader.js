import { api, ApiError } from "@/lib/api";

/**
 * Resilient recording upload. Never sends the whole file in one request, so it
 * works behind proxies/hosts with small body limits (nginx 1 MB, Vercel 4.5 MB,
 * preview proxies) that otherwise answer 413.
 *
 *  1. Ask the server for an upload plan.
 *     - Supabase mode  → "direct": browser PUTs the blob straight to Supabase
 *       Storage through a short-lived signed URL (bypasses our server entirely).
 *     - JSON/local mode → "chunked".
 *  2. Fallback / chunked: slice the blob (4 MB), POST each slice; on 413 halve
 *     the slice size (down to 256 KB) and retry the same offset; retry network /
 *     5xx errors with back-off.
 *  3. Tell the server the upload is complete → it assembles / verifies the file
 *     and stores the recording metadata.
 */

const MIN_CHUNK_BYTES = 256 * 1024;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RETRIES_PER_CHUNK = 4;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function putWithProgress(url, blob, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    for (const [k, v] of Object.entries(headers || {})) {
      if (v !== undefined && v !== null && v !== "") xhr.setRequestHeader(k, String(v));
    }
    xhr.timeout = 15 * 60 * 1000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status });
      else reject(new ApiError(`Direct upload failed (${xhr.status}): ${(xhr.responseText || "").slice(0, 200)}`, xhr.status, null));
    };
    xhr.onerror = () => reject(new ApiError("Direct upload failed (network error)", 0, null));
    xhr.ontimeout = () => reject(new ApiError("Direct upload timed out", 0, null));
    xhr.onabort = () => reject(new ApiError("Direct upload aborted", 0, null));
    xhr.send(blob);
  });
}

function metaPayload(meta) {
  return {
    started_at: meta.startedAt || null,
    ended_at: meta.endedAt || null,
    duration_seconds: Number.isFinite(Number(meta.durationSeconds)) ? Math.round(Number(meta.durationSeconds)) : null,
    recorder_chunks: meta.chunks ?? null,
    reason: meta.reason || null,
  };
}

async function uploadChunked({ sessionId, kind, blob, meta, uploadId, maxChunk, onProgress, log }) {
  let chunkSize = Math.max(MIN_CHUNK_BYTES, Math.min(maxChunk || DEFAULT_CHUNK_BYTES, DEFAULT_CHUNK_BYTES));
  let offset = 0;
  let index = 0;
  let retries = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    const slice = blob.slice(offset, end, blob.type);
    try {
      await api.uploadChunk(sessionId, { upload_id: uploadId, kind, offset, index, total_size: blob.size }, slice);
      offset = end;
      index += 1;
      retries = 0;
      if (onProgress) onProgress(offset / blob.size);
    } catch (err) {
      const status = err?.status || 0;
      if (status === 413 && chunkSize > MIN_CHUNK_BYTES) {
        chunkSize = Math.max(MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
        if (log) log("warn", `Upload chunk rejected as too large (413) - retrying with ${Math.round(chunkSize / 1024)} KB chunks`);
        continue;
      }
      if ((status === 0 || status >= 500 || status === 429 || status === 408) && retries < MAX_RETRIES_PER_CHUNK) {
        retries += 1;
        const wait = 800 * 2 ** (retries - 1);
        if (log) log("warn", `Upload chunk failed (${status || "network"}) - retry ${retries}/${MAX_RETRIES_PER_CHUNK} in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  return api.completeUpload(sessionId, { kind, mode: "chunked", upload_id: uploadId, chunks: index, total_size: blob.size, mime_type: blob.type, meta: metaPayload(meta) });
}

/**
 * Uploads one recording ("screen" | "audio"). Resolves with the server's recording info.
 * `onProgress(fraction, label)` is optional.
 */
export async function uploadRecordingResilient({ sessionId, kind, blob, meta = {}, onProgress, log }) {
  if (!blob || blob.size === 0) throw new Error(`No ${kind} recording data to upload.`);
  const report = (fraction, label) => onProgress && onProgress(Math.max(0, Math.min(1, fraction)), label);
  const mime = blob.type || (kind === "audio" ? "audio/webm" : "video/webm");

  let plan;
  try {
    plan = await api.getUploadPlan(sessionId, { kind, mime_type: mime, size: blob.size });
  } catch (err) {
    if (log) log("warn", `Upload plan request failed (${err.message}) - using chunked upload`);
    plan = { mode: "chunked", upload_id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, max_chunk_bytes: DEFAULT_CHUNK_BYTES };
  }

  if (plan.mode === "direct" && plan.url) {
    try {
      report(0, "direct");
      await putWithProgress(plan.url, blob, { "content-type": mime, ...(plan.headers || {}) }, (f) => report(f, "direct"));
      const done = await api.completeUpload(sessionId, { kind, mode: "direct", path: plan.path, total_size: blob.size, mime_type: mime, meta: metaPayload(meta) });
      if (log) log("info", `${kind} recording uploaded directly to storage (${(blob.size / (1024 * 1024)).toFixed(2)} MB)`);
      return done.recording;
    } catch (err) {
      if (log) log("warn", `Direct upload failed (${err.message}) - falling back to chunked upload through the server`);
    }
  }

  const done = await uploadChunked({ sessionId, kind, blob, meta, uploadId: plan.upload_id, maxChunk: plan.max_chunk_bytes, onProgress: (f) => report(f, "chunked"), log });
  if (log) log("info", `${kind} recording uploaded in chunks (${(blob.size / (1024 * 1024)).toFixed(2)} MB)`);
  return done.recording;
}

import fs from "fs";
import { Readable } from "stream";
import { after } from "next/server";
import { getSession, updateSession, sanitizeTranscript, getResult, SESSION_STATUS } from "@/lib/server/sessions";
import { getProcess } from "@/lib/server/processes";
import { db } from "@/lib/server/db";
import { isValidSessionId } from "@/lib/server/storage";
import { nowIso } from "@/lib/server/storage";
import { getGeminiConfig, GeminiNotConfiguredError } from "@/lib/server/gemini";
import { sendInviteForSession, sendResultForSession, recertify } from "@/lib/server/certifications";
import { isEvaluationRunning, markEvaluationStarted, startEvaluationJob } from "@/lib/server/evaluation-job";
import { MAX_CHUNK_BYTES, assembleChunks, cleanupUpload, isValidUploadId, newUploadId, storeChunk } from "@/lib/server/uploads";
import fsp from "fs/promises";
import { errorResponse, json, httpError, readJsonBody, publicBaseUrl } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Evaluation (video analysis) continues after the response via after(); allow long-running work on serverless hosts.
export const maxDuration = 300;

const KINDS = new Set(["screen", "audio"]);

async function loadSessionOr404(sessionId) {
  if (!isValidSessionId(sessionId)) throw httpError("Invalid session id", 400);
  const session = await getSession(sessionId);
  if (!session) throw httpError(`Certification '${sessionId}' not found`, 404);
  return session;
}

// POST /start  { agent_name }
async function handleStart(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  if (session.status === SESSION_STATUS.COMPLETED) throw httpError("This certification is already completed.", 409);
  const agentName = String(body.agent_name || session.agent_name || "").trim().slice(0, 120) || "Agent";
  const updated = await updateSession(sessionId, (s) => {
    s.agent_name = agentName;
    s.status = SESSION_STATUS.LIVE;
    s.started_at = nowIso();
    s.ended_at = null;
    s.duration_seconds = null;
    s.ended_reason = null;
    s.transcript = [];
    s.transcript_final = false;
    s.error = null;
    s.attempts = (s.attempts || 0) + 1;
    return s;
  });
  return json({ session: updated });
}

// POST /transcript  { transcript, final? }
async function handleTranscript(sessionId, request) {
  const body = await readJsonBody(request);
  await loadSessionOr404(sessionId);
  const transcript = sanitizeTranscript(body.transcript);
  const updated = await updateSession(sessionId, (s) => {
    if (!body.final && Array.isArray(s.transcript) && s.transcript.length > transcript.length) return s; // never shrink
    s.transcript = transcript;
    if (body.final) s.transcript_final = true;
    return s;
  });
  return json({ ok: true, turns: updated.transcript.length });
}

function parseKind(value) {
  const kind = String(value || "").trim();
  if (!KINDS.has(kind)) throw httpError("kind must be 'screen' or 'audio'", 400);
  return kind;
}

/** Persists recording metadata (session + recordings/<id>/metadata.json) after any upload path. */
async function recordRecording(session, kind, { mime, size, stored, meta = {} }) {
  const duration = Number(meta.duration_seconds);
  const info = {
    file: `${kind}.webm`,
    mime_type: mime || (kind === "audio" ? "audio/webm" : "video/webm"),
    size_bytes: size,
    started_at: typeof meta.started_at === "string" ? meta.started_at : null,
    ended_at: typeof meta.ended_at === "string" ? meta.ended_at : null,
    duration_seconds: Number.isFinite(duration) ? Math.round(duration) : null,
    uploaded_at: nowIso(),
    upload_mode: meta.upload_mode || "single",
    storage: stored.storage,
    bucket: stored.bucket || null,
    path: stored.path,
  };
  await db.writeRecordingMetadata(session.session_id, { session_id: session.session_id, process_id: session.process_id, agent_name: session.agent_name, started_at: session.started_at, recordings: { [kind]: info } });
  const updated = await updateSession(session.session_id, (s) => {
    s.recording = { ...(s.recording || {}), [kind]: info };
    return s;
  });
  return updated.recording[kind];
}

// POST /upload-screen | /upload-audio   (legacy single request, raw webm body - small files only)
async function handleUpload(sessionId, request, kind) {
  const session = await loadSessionOr404(sessionId);
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length) throw httpError("Empty upload body", 400);
  const header = (name) => request.headers.get(name) || null;
  const mime = header("content-type") || (kind === "audio" ? "audio/webm" : "video/webm");
  const stored = await db.saveRecording(sessionId, kind, buffer, mime);
  const recording = await recordRecording(session, kind, {
    mime,
    size: buffer.length,
    stored,
    meta: { started_at: header("x-recording-started-at"), ended_at: header("x-recording-ended-at"), duration_seconds: header("x-recording-duration"), upload_mode: "single" },
  });
  return json({ ok: true, recording });
}

// POST /upload-url  { kind, mime_type, size } -> upload plan (direct signed URL or chunked)
async function handleUploadUrl(sessionId, request) {
  const body = await readJsonBody(request);
  await loadSessionOr404(sessionId);
  const kind = parseKind(body.kind);
  const mime = String(body.mime_type || (kind === "audio" ? "audio/webm" : "video/webm")).slice(0, 100);
  const uploadId = newUploadId();
  try {
    const direct = await db.createRecordingUploadUrl(sessionId, kind, mime);
    if (direct && direct.url) {
      return json({ mode: "direct", url: direct.url, headers: direct.headers || {}, path: direct.path, upload_id: uploadId, max_chunk_bytes: MAX_CHUNK_BYTES });
    }
  } catch (err) {
    console.warn(`[upload-url] signed URL unavailable for ${sessionId}/${kind}: ${err.message} - using chunked upload`);
  }
  return json({ mode: "chunked", upload_id: uploadId, max_chunk_bytes: MAX_CHUNK_BYTES });
}

// POST /upload-chunk?upload_id=&kind=&offset=&total_size=   (raw body slice)
async function handleUploadChunk(sessionId, request) {
  await loadSessionOr404(sessionId);
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("upload_id");
  if (!isValidUploadId(uploadId)) throw httpError("Invalid upload_id", 400);
  parseKind(url.searchParams.get("kind"));
  const offset = Number(url.searchParams.get("offset"));
  const buffer = Buffer.from(await request.arrayBuffer());
  const stored = await storeChunk({ sessionId, uploadId, offset, buffer });
  return json({ ok: true, ...stored });
}

// POST /upload-complete  { kind, mode: "direct"|"chunked", upload_id?, path?, total_size, mime_type, meta }
async function handleUploadComplete(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  const kind = parseKind(body.kind);
  const mime = String(body.mime_type || (kind === "audio" ? "audio/webm" : "video/webm")).slice(0, 100);
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const totalSize = Number(body.total_size);

  if (body.mode === "direct") {
    const info = await db.getRecordingObjectInfo(sessionId, kind);
    if (!info) throw httpError("The uploaded recording was not found in storage. Please retry the upload.", 400);
    if (Number.isFinite(totalSize) && totalSize > 0 && info.size_bytes > 0 && Math.abs(info.size_bytes - totalSize) > 1024) {
      throw httpError(`Uploaded recording is incomplete (${info.size_bytes} of ${totalSize} bytes). Please retry the upload.`, 400);
    }
    const recording = await recordRecording(session, kind, { mime, size: info.size_bytes || totalSize || 0, stored: { storage: info.storage, bucket: info.bucket, path: info.path || `${sessionId}/${kind}.webm` }, meta: { ...meta, upload_mode: "direct" } });
    return json({ ok: true, recording });
  }

  const uploadId = body.upload_id;
  if (!isValidUploadId(uploadId)) throw httpError("Invalid upload_id", 400);
  const assembled = await assembleChunks({ sessionId, uploadId, totalSize });
  try {
    const buffer = await fsp.readFile(assembled.filePath);
    const stored = await db.saveRecording(sessionId, kind, buffer, mime);
    const recording = await recordRecording(session, kind, { mime, size: buffer.length, stored, meta: { ...meta, upload_mode: "chunked" } });
    return json({ ok: true, recording, chunks: assembled.chunks });
  } finally {
    await cleanupUpload(sessionId, uploadId);
  }
}

// POST /end
async function handleEnd(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  if (session.status === SESSION_STATUS.COMPLETED) throw httpError("This certification is already completed.", 409);
  const endedAt = typeof body.ended_at === "string" ? body.ended_at : nowIso();
  const transcript = Array.isArray(body.transcript) ? sanitizeTranscript(body.transcript) : null;

  const updated = await updateSession(sessionId, (s) => {
    if (typeof body.started_at === "string") s.started_at = body.started_at;
    if (!s.started_at) s.started_at = s.created_at;
    s.ended_at = endedAt;
    const computed = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(s.started_at).getTime()) / 1000));
    const provided = Number(body.duration_seconds);
    s.duration_seconds = Number.isFinite(provided) && provided >= 0 ? Math.round(provided) : computed;
    s.ended_reason = String(body.ended_reason || "agent_ended").slice(0, 80);
    if (transcript && (!Array.isArray(s.transcript) || transcript.length >= s.transcript.length)) {
      s.transcript = transcript;
      s.transcript_final = true;
    }
    if (Array.isArray(body.client_log)) s.client_log = body.client_log.slice(-200);
    s.status = SESSION_STATUS.ENDED;
    return s;
  });
  await db.writeRecordingMetadata(sessionId, {
    session_id: sessionId,
    process_id: updated.process_id,
    agent_name: updated.agent_name,
    started_at: updated.started_at,
    ended_at: updated.ended_at,
    duration_seconds: updated.duration_seconds,
    ended_reason: updated.ended_reason,
  });
  return json({ ok: true, session: updated });
}

// POST /evaluate  { force? }  -> starts the background pipeline, returns 202; poll GET /api/certifications/{id}
async function handleEvaluate(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  if (!session.process_id) throw httpError("Session has no process.", 409);
  if (session.status === SESSION_STATUS.COMPLETED && !body.force) {
    const existing = await getResult(sessionId);
    if (existing) return json({ result: existing, session, cached: true });
  }
  if (!session.ended_at && !body.force) throw httpError("End the certification before evaluating.", 409);
  if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
  if (!(await getProcess(session.process_id))) throw httpError(`Process '${session.process_id}' not found`, 404);

  if (isEvaluationRunning(session) && !body.force) {
    return json({ queued: true, already_running: true, session }, { status: 202 });
  }

  await markEvaluationStarted(sessionId);
  const baseUrl = publicBaseUrl(request);
  const kickoff = () => startEvaluationJob(sessionId, baseUrl);
  try {
    after(kickoff); // continue after the response is flushed
  } catch {
    kickoff();
  }
  return json({ queued: true, session: await getSession(sessionId) }, { status: 202 });
}

// POST /resend-invite | /resend-result
async function handleResend(sessionId, request, kind) {
  await loadSessionOr404(sessionId);
  const base = publicBaseUrl(request);
  const status = kind === "invite" ? await sendInviteForSession(sessionId, base) : await sendResultForSession(sessionId, base);
  if (status.status === "failed") throw httpError(status.error || status.team?.error || "Email failed", 502);
  if (status.status === "skipped") throw httpError(status.reason || status.team?.reason || "Email skipped - check Email settings and recipients.", 400);
  return json({ ok: true, email: status, session: await getSession(sessionId) });
}

// POST /recertify  { send_email?, force? }
async function handleRecertify(sessionId, request) {
  const body = await readJsonBody(request);
  await loadSessionOr404(sessionId);
  const out = await recertify({ sessionId, sendEmail: body.send_email !== false, baseUrl: publicBaseUrl(request), force: Boolean(body.force) });
  return json({ session: out.session, certification_url: out.url, email: out.email, reused: out.reused, attempt_no: out.attempt_no, max_attempts: out.max_attempts }, { status: 201 });
}

// GET /result
async function handleResult(sessionId) {
  const session = await loadSessionOr404(sessionId);
  const result = await getResult(sessionId);
  if (!result) throw httpError(session.status === SESSION_STATUS.ERROR ? session.error || "Evaluation failed." : "Result not available yet.", 404, "RESULT_NOT_READY");
  return json({ result, session });
}

// GET /recording?type=screen|audio  -> signed URL redirect (Supabase) or file stream with Range (local)
async function handleRecording(sessionId, request) {
  await loadSessionOr404(sessionId);
  const url = new URL(request.url);
  const kind = url.searchParams.get("type") === "audio" ? "audio" : "screen";
  const access = await db.getRecordingAccess(sessionId, kind);
  if (!access) throw httpError(`No ${kind} recording found for this session.`, 404);
  if (access.type === "url") return Response.redirect(access.url, 302);

  const mime = kind === "audio" ? "audio/webm" : "video/webm";
  const size = access.size;
  const range = request.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(access.path, { start, end })), {
      status: 206,
      headers: { "Content-Type": mime, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(access.path)), {
    status: 200,
    headers: { "Content-Type": mime, "Content-Length": String(size), "Accept-Ranges": "bytes", "Cache-Control": "no-store" },
  });
}

export async function POST(request, context) {
  try {
    const { sessionId, action } = await context.params;
    switch (action) {
      case "start":
        return await handleStart(sessionId, request);
      case "transcript":
        return await handleTranscript(sessionId, request);
      case "upload-screen":
        return await handleUpload(sessionId, request, "screen");
      case "upload-audio":
        return await handleUpload(sessionId, request, "audio");
      case "upload-url":
        return await handleUploadUrl(sessionId, request);
      case "upload-chunk":
        return await handleUploadChunk(sessionId, request);
      case "upload-complete":
        return await handleUploadComplete(sessionId, request);
      case "end":
        return await handleEnd(sessionId, request);
      case "evaluate":
        return await handleEvaluate(sessionId, request);
      case "recertify":
        return await handleRecertify(sessionId, request);
      case "resend-invite":
        return await handleResend(sessionId, request, "invite");
      case "resend-result":
        return await handleResend(sessionId, request, "result");
      default:
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request, context) {
  try {
    const { sessionId, action } = await context.params;
    switch (action) {
      case "result":
        return await handleResult(sessionId);
      case "recording":
        return await handleRecording(sessionId, request);
      default:
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

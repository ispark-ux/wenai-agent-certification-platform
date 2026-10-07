import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { assertValidSessionId } from "./storage";

/**
 * Temporary store for chunked recording uploads. Chunks are keyed by byte
 * offset (chunk sizes may shrink mid-upload when a proxy answers 413), written
 * to the OS temp dir and assembled into one file on completion.
 */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const HARD_CHUNK_LIMIT = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const ROOT = path.join(os.tmpdir(), "aac-uploads");

export function isValidUploadId(id) {
  return typeof id === "string" && UPLOAD_ID_RE.test(id);
}

export function newUploadId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`;
}

function uploadDir(sessionId, uploadId) {
  assertValidSessionId(sessionId);
  if (!isValidUploadId(uploadId)) {
    const err = new Error("Invalid upload id");
    err.status = 400;
    throw err;
  }
  return path.join(ROOT, sessionId, uploadId);
}

export async function storeChunk({ sessionId, uploadId, offset, buffer }) {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_UPLOAD_BYTES) {
    const err = new Error("Invalid chunk offset");
    err.status = 400;
    throw err;
  }
  if (!buffer || buffer.length === 0) {
    const err = new Error("Empty chunk");
    err.status = 400;
    throw err;
  }
  if (buffer.length > HARD_CHUNK_LIMIT) {
    const err = new Error(`Chunk too large (max ${HARD_CHUNK_LIMIT} bytes)`);
    err.status = 413;
    throw err;
  }
  const dir = uploadDir(sessionId, uploadId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${String(offset).padStart(13, "0")}.part`);
  const tmp = `${file}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, file); // idempotent re-uploads of the same offset simply overwrite
  return { offset, size: buffer.length };
}

/** Verifies contiguity + total size and concatenates the parts into one file. Returns its path. */
export async function assembleChunks({ sessionId, uploadId, totalSize }) {
  const dir = uploadDir(sessionId, uploadId);
  let names;
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".part")).sort();
  } catch {
    const err = new Error("No uploaded chunks found for this upload (the server may have restarted - please retry the upload).");
    err.status = 400;
    throw err;
  }
  const parts = [];
  for (const name of names) {
    const offset = parseInt(name.replace(".part", ""), 10);
    const stat = await fsp.stat(path.join(dir, name));
    parts.push({ name, offset, size: stat.size });
  }
  parts.sort((a, b) => a.offset - b.offset);
  let expected = 0;
  for (const p of parts) {
    if (p.offset !== expected) {
      const err = new Error(`Upload is incomplete: missing bytes at offset ${expected}.`);
      err.status = 400;
      throw err;
    }
    expected += p.size;
  }
  if (Number.isFinite(totalSize) && totalSize > 0 && expected !== totalSize) {
    const err = new Error(`Upload size mismatch: received ${expected} bytes, expected ${totalSize}.`);
    err.status = 400;
    throw err;
  }
  if (expected === 0) {
    const err = new Error("Upload is empty.");
    err.status = 400;
    throw err;
  }
  const out = path.join(dir, "assembled.bin");
  const ws = fs.createWriteStream(out);
  for (const p of parts) {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(path.join(dir, p.name));
      rs.on("error", reject);
      rs.on("end", resolve);
      rs.pipe(ws, { end: false });
    });
  }
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.end(resolve);
  });
  return { filePath: out, size: expected, chunks: parts.length };
}

export async function cleanupUpload(sessionId, uploadId) {
  try {
    await fsp.rm(uploadDir(sessionId, uploadId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

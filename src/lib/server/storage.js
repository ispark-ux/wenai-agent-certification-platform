import fs from "fs";
import fsp from "fs/promises";
import path from "path";

/**
 * File-based storage layer (no database).
 *
 * data/
 *   processes/      -> one JSON per certification process (sotrue.json, flipkart.json, ...)
 *   certifications/ -> sessions.json (all certification sessions)
 *   results/        -> <session_id>.json (evaluation scorecards)
 * recordings/
 *   <session_id>/   -> screen.webm, audio.webm, metadata.json
 *
 * Every write is atomic (temp file + rename) and serialised per file with an
 * in-process async lock so concurrent API calls cannot corrupt the JSON.
 * Swapping this module for a PostgreSQL/MySQL repository later only requires
 * re-implementing the same functions.
 */

const ROOT = process.cwd();

export const DATA_DIR = path.join(ROOT, "data");
export const PROCESSES_DIR = path.join(DATA_DIR, "processes");
export const CERTIFICATIONS_DIR = path.join(DATA_DIR, "certifications");
export const RESULTS_DIR = path.join(DATA_DIR, "results");
export const RECORDINGS_DIR = path.join(ROOT, "recordings");
export const SESSIONS_FILE = path.join(CERTIFICATIONS_DIR, "sessions.json");
export const AGENTS_FILE = path.join(DATA_DIR, "agents.json");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const EMAIL_LOGS_FILE = path.join(DATA_DIR, "email_logs.json");

const SESSION_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,63}$/;

export function ensureStorage() {
  for (const dir of [DATA_DIR, PROCESSES_DIR, CERTIFICATIONS_DIR, RESULTS_DIR, RECORDINGS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, "[]\n", "utf8");
  }
}

export function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

export function assertValidSessionId(sessionId) {
  if (!isValidSessionId(sessionId)) {
    const err = new Error("Invalid session id");
    err.status = 400;
    throw err;
  }
  return sessionId;
}

export function resultFile(sessionId) {
  assertValidSessionId(sessionId);
  return path.join(RESULTS_DIR, `${sessionId}.json`);
}

export function recordingDir(sessionId) {
  assertValidSessionId(sessionId);
  return path.join(RECORDINGS_DIR, sessionId);
}

export function recordingFile(sessionId, kind = "screen") {
  const safeKind = kind === "audio" ? "audio" : "screen";
  return path.join(recordingDir(sessionId), `${safeKind}.webm`);
}

export function recordingMetadataFile(sessionId) {
  return path.join(recordingDir(sessionId), "metadata.json");
}

// ---------------------------------------------------------------------------
// Async per-key lock (serialises read-modify-write cycles on the same file)
// ---------------------------------------------------------------------------
const lockQueues = new Map();

export function withLock(key, fn) {
  const previous = lockQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  lockQueues.set(key, tail);
  tail.then(() => {
    if (lockQueues.get(key) === tail) lockQueues.delete(key);
  });
  return run;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

/** Atomically read + transform + write a JSON file under its lock. */
export function updateJson(file, fallback, updater) {
  return withLock(file, async () => {
    const current = await readJson(file, fallback);
    const next = await updater(current);
    await writeJsonAtomic(file, next);
    return next;
  });
}

export async function fileStat(file) {
  try {
    return await fsp.stat(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

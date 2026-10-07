import fsp from "fs/promises";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { PROCESSES_DIR, readJson, assertValidSessionId, nowIso } from "../storage";

/**
 * Supabase repository. Activated when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (or SUPABASE_SECRET_KEY) are set. Tables are created by supabase/schema.sql.
 * Recordings go to the private storage bucket (default "recordings").
 */
export function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
  const bucket = (process.env.SUPABASE_RECORDINGS_BUCKET || "recordings").trim();
  return { url, key, bucket, configured: Boolean(url && key) };
}

const T = {
  processes: "processes",
  agents: "agents",
  sessions: "certification_sessions",
  results: "certification_results",
  settings: "app_settings",
  emails: "email_logs",
};

const SESSION_COLUMNS = [
  "id",
  "process_id",
  "process_name",
  "scenario_title",
  "agent_id",
  "agent_name",
  "agent_email",
  "employee_id",
  "status",
  "created_at",
  "started_at",
  "ended_at",
  "duration_seconds",
  "ended_reason",
  "attempts",
  "transcript",
  "transcript_final",
  "recording",
  "live",
  "evaluation",
  "result_summary",
  "invite_email",
  "result_email",
  "client_log",
  "error",
  "attempt_no",
  "recertification_of",
  "updated_at",
];

const PROCESS_COLUMNS = ["process_id", "name", "tagline", "description", "language", "active", "customer_name", "opening_line", "ai_prompt", "evaluator_notes", "notification_emails", "config", "created_at", "updated_at"];

function fail(error, what) {
  const message = error?.message || String(error);
  const hint = /does not exist|schema cache|relation|42P01|PGRST205/i.test(message) ? " - run supabase/schema.sql in the Supabase SQL editor." : "";
  const err = new Error(`Supabase ${what} failed: ${message}${hint}`);
  err.status = 502;
  err.code = error?.code;
  throw err;
}

// ---- row mappers -----------------------------------------------------------
function toProcessRow(p) {
  const { process_id, process_name, name, tagline, description, language, active, ai_prompt, evaluator_notes, notification_emails, created_at, updated_at, customer_name, opening_line, ...rest } = p;
  const config = { ...rest };
  return {
    process_id,
    name: process_name || name || process_id,
    tagline: tagline || "",
    description: description || "",
    language: language || "",
    active: active !== false,
    customer_name: rest.customer_profile?.name || customer_name || "Customer",
    opening_line: rest.scenario?.opening_line || opening_line || "",
    ai_prompt: ai_prompt || "",
    evaluator_notes: evaluator_notes || "",
    notification_emails: Array.isArray(notification_emails) ? notification_emails : [],
    config,
    created_at: created_at || nowIso(),
    updated_at: nowIso(),
  };
}

function fromProcessRow(r) {
  if (!r) return null;
  const config = r.config || {};
  return {
    ...config,
    process_id: r.process_id,
    process_name: r.name,
    tagline: r.tagline || "",
    description: r.description || "",
    language: r.language || "",
    active: r.active !== false,
    ai_prompt: r.ai_prompt || "",
    evaluator_notes: r.evaluator_notes || "",
    notification_emails: Array.isArray(r.notification_emails) ? r.notification_emails : [],
    customer_profile: { ...(config.customer_profile || {}), name: r.customer_name || config.customer_profile?.name || "Customer" },
    scenario: { ...(config.scenario || {}), opening_line: r.opening_line || config.scenario?.opening_line || "" },
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toSessionRow(s) {
  const row = {};
  for (const col of SESSION_COLUMNS) {
    const key = col === "id" ? "session_id" : col;
    if (s[key] !== undefined) row[col] = s[key];
  }
  row.id = s.session_id;
  row.updated_at = nowIso();
  return row;
}

function fromSessionRow(r) {
  if (!r) return null;
  const { id, ...rest } = r;
  return { session_id: id, ...rest };
}

function toResultRow(r) {
  return {
    session_id: r.session_id,
    process_id: r.process_id || null,
    agent_name: r.agent_name || null,
    agent_email: r.agent_email || null,
    total_marks: r.total_marks ?? null,
    maximum_marks: r.maximum_marks ?? null,
    applicable_marks: r.applicable_marks ?? null,
    percentage: r.percentage ?? null,
    earned_percentage: r.earned_percentage ?? null,
    raw_percentage: r.raw_percentage ?? null,
    passed: Boolean(r.passed),
    passing_percentage: r.passing_percentage ?? null,
    ztp_failed: Boolean(r.ztp_failed),
    counts: r.counts || null,
    groups: r.groups || null,
    parameters: r.parameters || null,
    resolution_achieved: r.resolution_achieved ?? null,
    overall_feedback: r.overall_feedback || null,
    strengths: r.strengths || null,
    improvements: r.improvements || null,
    evidence_sources: r.evidence_sources || null,
    screen_analyzed: Boolean(r.evidence_sources?.screen_video_analyzed),
    screen_analysis: r.screen_analysis || null,
    model: r.model || null,
    evaluated_at: r.evaluated_at || nowIso(),
    data: r,
  };
}

const LITE_SESSION_COLUMNS = SESSION_COLUMNS.filter((c) => c !== "transcript" && c !== "client_log").join(",");
const RESULT_LIST_COLUMNS =
  "session_id,process_id,agent_name,agent_email,total_marks,maximum_marks,applicable_marks,percentage,passed,ztp_failed,counts,groups,parameters,evidence_sources,evaluated_at,verification:screen_analysis->verification,cross_check:screen_analysis->cross_check";

export function createSupabaseRepo(cfg) {
  const sb = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

  /** PostgREST returns max 1000 rows per request - page through. */
  async function selectAll(table, columns, orderCol, max) {
    const out = [];
    for (let from = 0; from < max; from += 1000) {
      const { data, error } = await sb.from(table).select(columns).order(orderCol, { ascending: false }).range(from, Math.min(from + 999, max - 1));
      if (error) return { error };
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return { data: out };
  }
  let seeded = false;
  let bucketReady = null;

  async function ensureBucket() {
    if (!bucketReady) {
      bucketReady = (async () => {
        const { data } = await sb.storage.getBucket(cfg.bucket);
        if (!data) {
          const { error } = await sb.storage.createBucket(cfg.bucket, { public: false });
          if (error && !/already exists|duplicate/i.test(error.message || "")) fail(error, `create bucket '${cfg.bucket}'`);
        }
      })().catch((err) => {
        bucketReady = null;
        throw err;
      });
    }
    return bucketReady;
  }

  const repo = {
    mode: "supabase",

    async ping() {
      const { error } = await sb.from(T.processes).select("process_id", { head: true, count: "exact" });
      if (error) fail(error, "connection check");
      return { ok: true };
    },

    /** Seeds the processes table from data/processes/*.json the first time it is empty. */
    async ensureSeed() {
      if (seeded) return;
      const { data, error } = await sb.from(T.processes).select("process_id").limit(1);
      if (error) fail(error, "select processes");
      if (!data || data.length === 0) {
        let files = [];
        try {
          files = (await fsp.readdir(PROCESSES_DIR)).filter((f) => f.toLowerCase().endsWith(".json"));
        } catch {
          files = [];
        }
        for (const file of files) {
          const p = await readJson(path.join(PROCESSES_DIR, file), null);
          if (p && p.process_id) {
            const { error: upErr } = await sb.from(T.processes).upsert(toProcessRow(p), { onConflict: "process_id" });
            if (upErr) console.error(`[supabase] seed ${file} failed:`, upErr.message);
            else console.log(`[supabase] seeded process ${p.process_id} from ${file}`);
          }
        }
      }
      seeded = true;
    },

    // ---- processes
    async listProcesses() {
      const { data, error } = await sb.from(T.processes).select("*").order("name");
      if (error) fail(error, "list processes");
      return (data || []).map(fromProcessRow);
    },
    async getProcess(processId) {
      if (!processId) return null;
      const { data, error } = await sb.from(T.processes).select("*").ilike("process_id", String(processId).trim()).limit(1);
      if (error) fail(error, "get process");
      return data && data.length ? fromProcessRow(data[0]) : null;
    },
    async saveProcess(p) {
      const { error } = await sb.from(T.processes).upsert(toProcessRow(p), { onConflict: "process_id" });
      if (error) fail(error, "save process");
      return p;
    },
    async deleteProcess(processId) {
      const { error, count } = await sb.from(T.processes).delete({ count: "exact" }).eq("process_id", processId);
      if (error) fail(error, "delete process");
      return (count || 0) > 0;
    },

    // ---- agents
    async listAgents({ process_id } = {}) {
      let q = sb.from(T.agents).select("*").order("name");
      if (process_id) q = q.eq("process_id", process_id);
      const { data, error } = await q;
      if (error) fail(error, "list agents");
      return data || [];
    },
    async getAgent(agentId) {
      const { data, error } = await sb.from(T.agents).select("*").eq("id", agentId).maybeSingle();
      if (error) fail(error, "get agent");
      return data || null;
    },
    async saveAgent(agent) {
      const { error } = await sb.from(T.agents).upsert({ ...agent, updated_at: nowIso() }, { onConflict: "id" });
      if (error) fail(error, "save agent");
      return agent;
    },
    async deleteAgent(agentId) {
      const { error, count } = await sb.from(T.agents).delete({ count: "exact" }).eq("id", agentId);
      if (error) fail(error, "delete agent");
      return (count || 0) > 0;
    },

    // ---- sessions
    async listSessions({ limit = 200 } = {}) {
      const { data, error } = await sb.from(T.sessions).select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) fail(error, "list sessions");
      return (data || []).map(fromSessionRow);
    },
    /** Sessions without transcript / client log (analytics, lists). */
    async listSessionsLite({ limit = 5000 } = {}) {
      const { data, error } = await selectAll(T.sessions, LITE_SESSION_COLUMNS, "created_at", limit);
      if (error) fail(error, "list sessions");
      return (data || []).map(fromSessionRow);
    },
    async listResults({ limit = 5000 } = {}) {
      const { data, error } = await selectAll(T.results, RESULT_LIST_COLUMNS, "evaluated_at", limit);
      if (error) fail(error, "list results");
      return (data || []).map(({ verification, cross_check, ...r }) => ({
        ...r,
        screen_analysis:
          verification || cross_check
            ? { analyzed: true, verification: verification || [], cross_check: cross_check || null, portal_verdict: r.evidence_sources?.screen_portal_verdict || null, crm_verdict: r.evidence_sources?.screen_crm_verdict || null }
            : null,
      }));
    },
    async getSession(sessionId) {
      assertValidSessionId(sessionId);
      const { data, error } = await sb.from(T.sessions).select("*").eq("id", sessionId).maybeSingle();
      if (error) fail(error, "get session");
      return fromSessionRow(data);
    },
    async createSession(session) {
      const { error } = await sb.from(T.sessions).insert(toSessionRow(session));
      if (error) fail(error, "create session");
      return session;
    },
    async updateSession(sessionId, updater) {
      const current = await repo.getSession(sessionId);
      if (!current) {
        const err = new Error(`Session ${sessionId} not found`);
        err.status = 404;
        throw err;
      }
      const next = updater(current) || current;
      const { error } = await sb.from(T.sessions).upsert(toSessionRow(next), { onConflict: "id" });
      if (error) fail(error, "update session");
      return next;
    },

    // ---- results
    async getResult(sessionId) {
      const { data, error } = await sb.from(T.results).select("data").eq("session_id", sessionId).maybeSingle();
      if (error) fail(error, "get result");
      return data ? data.data : null;
    },
    async saveResult(result) {
      const { error } = await sb.from(T.results).upsert(toResultRow(result), { onConflict: "session_id" });
      if (error) fail(error, "save result");
      return result;
    },

    // ---- settings
    async getSetting(key) {
      const { data, error } = await sb.from(T.settings).select("value").eq("key", key).maybeSingle();
      if (error) fail(error, "get settings");
      return data ? data.value : null;
    },
    async saveSetting(key, value) {
      const { error } = await sb.from(T.settings).upsert({ key, value, updated_at: nowIso() }, { onConflict: "key" });
      if (error) fail(error, "save settings");
      return value;
    },

    // ---- email logs
    async logEmail(entry) {
      const row = { session_id: entry.session_id || null, type: entry.type || null, recipients: entry.to || [], cc: entry.cc || [], subject: entry.subject || null, status: entry.status || null, error: entry.error || null, message_id: entry.message_id || null };
      const { error } = await sb.from(T.emails).insert(row);
      if (error) console.error("[supabase] email log failed:", error.message);
      return row;
    },
    async listEmailLogs(limit = 100) {
      const { data, error } = await sb.from(T.emails).select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) fail(error, "list email logs");
      return data || [];
    },

    // ---- recordings (Supabase Storage)
    /** Short-lived signed URL so the browser can PUT the recording straight into the bucket (no server body limits). */
    async createRecordingUploadUrl(sessionId, kind, mimeType) {
      assertValidSessionId(sessionId);
      await ensureBucket();
      const objectPath = `${sessionId}/${kind}.webm`;
      let { data, error } = await sb.storage.from(cfg.bucket).createSignedUploadUrl(objectPath, { upsert: true });
      if (error && /exists|duplicate/i.test(error.message || "")) {
        await sb.storage.from(cfg.bucket).remove([objectPath]);
        ({ data, error } = await sb.storage.from(cfg.bucket).createSignedUploadUrl(objectPath, { upsert: true }));
      }
      if (error || !data?.signedUrl) fail(error || new Error("no signed URL"), `create signed upload URL for ${kind}`);
      return { url: data.signedUrl, path: objectPath, headers: { "content-type": mimeType || (kind === "audio" ? "audio/webm" : "video/webm"), "x-upsert": "true", "cache-control": "3600" }, storage: "supabase", bucket: cfg.bucket };
    },
    async getRecordingObjectInfo(sessionId, kind) {
      assertValidSessionId(sessionId);
      const objectPath = `${sessionId}/${kind}.webm`;
      try {
        const { data, error } = await sb.storage.from(cfg.bucket).info(objectPath);
        if (!error && data) return { size_bytes: Number(data.size ?? data.metadata?.size ?? data.contentLength) || 0, storage: "supabase", bucket: cfg.bucket, path: objectPath };
      } catch {
        /* fall through to list() */
      }
      const { data: items, error: listErr } = await sb.storage.from(cfg.bucket).list(sessionId, { search: `${kind}.webm`, limit: 10 });
      if (listErr) fail(listErr, "verify uploaded recording");
      const item = (items || []).find((i) => i.name === `${kind}.webm`);
      return item ? { size_bytes: Number(item.metadata?.size) || 0, storage: "supabase", bucket: cfg.bucket, path: objectPath } : null;
    },
    async saveRecording(sessionId, kind, buffer, mimeType) {
      assertValidSessionId(sessionId);
      await ensureBucket();
      const objectPath = `${sessionId}/${kind}.webm`;
      const { error } = await sb.storage.from(cfg.bucket).upload(objectPath, buffer, { contentType: mimeType || "video/webm", upsert: true });
      if (error) fail(error, `upload ${kind} recording`);
      return { storage: "supabase", bucket: cfg.bucket, path: objectPath, size_bytes: buffer.length };
    },
    async getRecordingBuffer(sessionId, kind) {
      assertValidSessionId(sessionId);
      const { data, error } = await sb.storage.from(cfg.bucket).download(`${sessionId}/${kind}.webm`);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async getRecordingAccess(sessionId, kind) {
      assertValidSessionId(sessionId);
      const { data, error } = await sb.storage.from(cfg.bucket).createSignedUrl(`${sessionId}/${kind}.webm`, 3600);
      if (error || !data?.signedUrl) return null;
      return { type: "url", url: data.signedUrl };
    },
    async writeRecordingMetadata() {
      return null; // metadata lives in certification_sessions.recording
    },
  };
  return repo;
}

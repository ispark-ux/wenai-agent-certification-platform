import * as jsonRepo from "./json-repo";
import { createSupabaseRepo, supabaseConfig } from "./supabase-repo";

/**
 * Data access entry point. Picks Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are configured, otherwise falls back to local JSON files. All server modules use `db.*`.
 */
let repoInstance = null;

export function getRepo() {
  if (!repoInstance) {
    const cfg = supabaseConfig();
    repoInstance = cfg.configured ? createSupabaseRepo(cfg) : jsonRepo;
    console.log(`[db] Using ${repoInstance.mode} storage${cfg.configured ? ` (${cfg.url})` : ""}`);
  }
  return repoInstance;
}

export function dbInfo() {
  const cfg = supabaseConfig();
  return { mode: cfg.configured ? "supabase" : "json", supabase_url: cfg.configured ? cfg.url : null, bucket: cfg.configured ? cfg.bucket : null };
}

export const db = new Proxy(
  {},
  {
    get(_, prop) {
      return (...args) => {
        const repo = getRepo();
        if (typeof repo[prop] !== "function") throw new Error(`db.${String(prop)} is not implemented for ${repo.mode} storage`);
        return repo[prop](...args);
      };
    },
  }
);

-- ============================================================================
-- AI Agent Certification Platform - Supabase schema
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Then put SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the app's .env file.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- processes
-- One row per certification process (SoTrue, Flipkart, ...). The AI prompt,
-- evaluator notes and rubric live here; "config" holds the rest of the JSON
-- (scenario, rubric, scoring, live_settings, conversation_rules, ...).
create table if not exists public.processes (
  process_id           text primary key,
  name                 text not null,
  tagline              text not null default '',
  description          text not null default '',
  language             text not null default 'Hindi/Hinglish',
  active               boolean not null default true,
  customer_name        text not null default 'Customer',
  opening_line         text not null default '',
  ai_prompt            text not null default '',
  evaluator_notes      text not null default '',
  notification_emails  jsonb not null default '[]'::jsonb,
  config               jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------- agents
create table if not exists public.agents (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text,
  employee_id  text,
  process_id   text references public.processes(process_id) on delete set null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists agents_process_idx on public.agents (process_id);
create index if not exists agents_email_idx on public.agents (lower(email));

-- ---------------------------------------------------------------- sessions
create table if not exists public.certification_sessions (
  id                text primary key,                      -- CERT-YYYYMMDD-NNNNNN
  process_id        text references public.processes(process_id) on delete set null,
  process_name      text,
  scenario_title    text,
  agent_id          uuid references public.agents(id) on delete set null,
  agent_name        text,
  agent_email       text,
  employee_id       text,
  status            text not null default 'created',       -- created | live | ended | evaluating | completed | error
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_seconds  integer,
  ended_reason      text,
  attempts          integer not null default 0,
  transcript        jsonb not null default '[]'::jsonb,    -- [{index, speaker, text, timestamp, offset_seconds}]
  transcript_final  boolean not null default false,
  recording         jsonb not null default '{}'::jsonb,    -- {screen: {...}, audio: {...}} -> storage bucket paths
  live              jsonb not null default '{}'::jsonb,    -- Gemini Live model / token count
  evaluation        jsonb not null default '{}'::jsonb,    -- evaluation status
  result_summary    jsonb,                                 -- score summary (full result in certification_results)
  invite_email      jsonb,                                 -- invite email delivery status
  result_email      jsonb,                                 -- result email delivery status
  client_log        jsonb,
  error             text,
  updated_at        timestamptz not null default now()
);
-- Recertification tracking (safe to re-run)
alter table public.certification_sessions add column if not exists attempt_no integer not null default 1;
alter table public.certification_sessions add column if not exists recertification_of text;

create index if not exists sessions_created_idx on public.certification_sessions (created_at desc);
create index if not exists sessions_recert_idx  on public.certification_sessions (recertification_of);
create index if not exists sessions_status_idx  on public.certification_sessions (status);
create index if not exists sessions_process_idx on public.certification_sessions (process_id);
create index if not exists sessions_agent_idx   on public.certification_sessions (agent_id);

-- ---------------------------------------------------------------- results
create table if not exists public.certification_results (
  session_id          text primary key references public.certification_sessions(id) on delete cascade,
  process_id          text,
  agent_name          text,
  agent_email         text,
  total_marks         integer,
  maximum_marks       integer,
  applicable_marks    integer,
  percentage          numeric(5,1),                        -- final score (after ZTP)
  earned_percentage   numeric(5,1),                        -- before ZTP
  raw_percentage      numeric(5,1),                        -- out of maximum marks (NA included)
  passed              boolean not null default false,
  passing_percentage  numeric(5,1),
  ztp_failed          boolean not null default false,
  counts              jsonb,                               -- {C, NC, NA}
  groups              jsonb,                               -- section-wise totals
  parameters          jsonb,                               -- parameter-wise C/NC/NA, marks, reason, evidence
  resolution_achieved boolean,
  overall_feedback    text,
  strengths           jsonb,
  improvements        jsonb,
  evidence_sources    jsonb,
  model               text,
  evaluated_at        timestamptz,
  data                jsonb not null,                      -- complete scorecard JSON
  created_at          timestamptz not null default now()
);
-- Added for Gemini screen-recording analysis (safe to re-run)
alter table public.certification_results add column if not exists screen_analyzed boolean not null default false;
alter table public.certification_results add column if not exists screen_analysis jsonb;

create index if not exists results_process_idx on public.certification_results (process_id);
create index if not exists results_passed_idx  on public.certification_results (passed);

-- ---------------------------------------------------------------- settings
-- key = 'email' -> SMTP settings + notification recipients (set from Admin -> Email settings)
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- email logs
create table if not exists public.email_logs (
  id          uuid primary key default gen_random_uuid(),
  session_id  text,
  type        text,                                        -- invite | result | result_agent | test
  recipients  jsonb not null default '[]'::jsonb,
  cc          jsonb not null default '[]'::jsonb,
  subject     text,
  status      text,                                        -- sent | failed
  error       text,
  message_id  text,
  created_at  timestamptz not null default now()
);
create index if not exists email_logs_session_idx on public.email_logs (session_id);

-- ---------------------------------------------------------------- updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists processes_updated_at on public.processes;
create trigger processes_updated_at before update on public.processes for each row execute function public.set_updated_at();
drop trigger if exists agents_updated_at on public.agents;
create trigger agents_updated_at before update on public.agents for each row execute function public.set_updated_at();
drop trigger if exists sessions_updated_at on public.certification_sessions;
create trigger sessions_updated_at before update on public.certification_sessions for each row execute function public.set_updated_at();
drop trigger if exists settings_updated_at on public.app_settings;
create trigger settings_updated_at before update on public.app_settings for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- security
-- The app talks to Supabase with the service-role key (server side only), which
-- bypasses RLS. Enabling RLS with no policies blocks the anon/public keys.
alter table public.processes              enable row level security;
alter table public.agents                 enable row level security;
alter table public.certification_sessions enable row level security;
alter table public.certification_results  enable row level security;
alter table public.app_settings           enable row level security;
alter table public.email_logs             enable row level security;

-- ---------------------------------------------------------------- storage
-- Private bucket for screen + audio recordings: recordings/<SESSION_ID>/screen.webm, audio.webm
-- (Supabase free plan default upload limit is 50 MB per file; raise it under
--  Project Settings -> Storage if your screen recordings are larger.)
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('recordings', 'recordings', false)
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- useful views
drop view if exists public.certification_overview;
create view public.certification_overview as
select
  s.id as session_id,
  s.process_id,
  s.process_name,
  s.scenario_title,
  s.agent_name,
  s.agent_email,
  s.employee_id,
  s.status,
  s.attempt_no,
  s.recertification_of,
  s.created_at,
  s.started_at,
  s.ended_at,
  s.duration_seconds,
  r.total_marks,
  r.applicable_marks,
  r.percentage,
  r.passed,
  r.ztp_failed,
  r.evaluated_at
from public.certification_sessions s
left join public.certification_results r on r.session_id = s.id
order by s.created_at desc;

-- ---------------------------------------------------------------- analytics views
-- Agent-wise: attempts, best / latest score, certified flag
drop view if exists public.agent_certification_summary;
create view public.agent_certification_summary as
select
  coalesce(s.agent_id::text, lower(s.agent_email), lower(s.agent_name)) as agent_key,
  max(s.agent_name)  as agent_name,
  max(s.agent_email) as agent_email,
  s.process_id,
  count(*) filter (where s.status = 'completed')                         as completed_attempts,
  count(*)                                                               as total_links,
  max(r.percentage)                                                      as best_percentage,
  round(avg(r.percentage), 1)                                            as avg_percentage,
  bool_or(coalesce(r.passed, false))                                     as certified,
  max(r.evaluated_at)                                                    as last_evaluated_at
from public.certification_sessions s
left join public.certification_results r on r.session_id = s.id
where coalesce(s.agent_id::text, s.agent_email, s.agent_name) is not null
group by 1, s.process_id;

-- Pareto source: one row per evaluated parameter
drop view if exists public.parameter_results;
create view public.parameter_results as
select
  r.session_id,
  r.process_id,
  r.evaluated_at,
  p ->> 'id'                         as parameter_id,
  p ->> 'group'                      as parameter_group,
  p ->> 'parameter'                  as parameter,
  p ->> 'status'                     as status,
  (p ->> 'marks')::int               as marks,
  (p ->> 'max_marks')::int           as max_marks,
  case when p ->> 'status' = 'NA' then 0 else (p ->> 'max_marks')::int - (p ->> 'marks')::int end as marks_lost
from public.certification_results r
cross join lateral jsonb_array_elements(coalesce(r.parameters, '[]'::jsonb)) as p;

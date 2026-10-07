# AI Agent Certification Platform

**Flow**

1. **Admin → Processes → Add process**: name, customer name, opening line, **AI prompt** (the AI customer talks to the agent using this), evaluator notes (correct resolution etc.), scorecard (pre-filled with the standard 17 parameters / 100 marks, editable).
2. **Admin → Agents**: add agents (name, email, employee ID) to a process → **Send link** → the certification link is emailed to the agent.
3. **Admin → Certifications**: or create an open link for any process and copy it.
4. **Agent** opens the link → START → shares screen + mic → the **Gemini Live AI customer speaks first** → real call, recorded → END.
5. Transcript + audio + screen recording are uploaded → **Gemini audits** the call against the rubric → server computes the score → scorecard shown on the link **and emailed** to the configured To/CC (and the agent).
6. **Admin → Email settings**: SMTP host/port/user/password, From, To, CC, test email.

## Analytics & recertification (Admin → Analytics)

| Tab | What it shows |
| --- | --- |
| **Certification analysis** | KPIs (links, completed, pass rate, average/median score, first-attempt vs recertification pass rate, ZTP breaches, avg call time), daily trend, score distribution, section-wise performance, weakest parameters, portal/CRM verification stats, full parameter table (C/NC/NA, NC rate, compliance, marks lost) - CSV export |
| **Process-wise** | Comparison table across processes (links, completed, pass rate, avg/min/max, certified agents, ZTP, top defect) + one card per process with section bars, top-5 defects, screen verdicts and trend - CSV export |
| **Agent-wise** | Every agent (incl. registered agents not started yet): status (Certified / Not certified / Failed (ZTP) / In progress / Link sent / Not started), attempts used vs. allowed, latest / best / first score, improvement, sparkline trend, focus areas from the latest attempt, attempt history, **Recertify** per agent and **Recertify all eligible** in one click - search, filters, sorting, CSV export |
| **Pareto** | 80/20 analysis with Pareto chart (bars + cumulative line + 80 % line), "vital few" vs "useful many", an action plan and table for: parameters by marks lost, parameters by defect count, sections by marks lost, portal/CRM checks by failures - CSV export |

Filters: process + period (7 / 30 / 90 / 365 days / all time). Supabase also gets SQL views `agent_certification_summary` and `parameter_results` for your own reporting (BI tools / SQL editor).

**Recertification**: each process has rules (enabled, max attempts per agent - default 3, cooldown hours). "Recertify" (certifications list, detail page, agent-wise tab) creates the next attempt for the same agent + process, linked to the first attempt (`attempt_no`, `recertification_of`), reuses an unused open link instead of creating duplicates, blocks while another attempt is in progress, and emails a "Recertification - attempt N" invite. Limits can be overridden by the admin (force).

## Run (PowerShell)

```powershell
npm install
Copy-Item .env.example .env     # set GEMINI_API_KEY (+ Supabase keys, see below)
npm run dev                     # http://localhost:3000  -> admin panel
# production: npm run build ; npm run start
```

Desktop Chrome/Edge over HTTPS or localhost (browser requirement for screen + mic capture).

## Supabase (recommended)

1. Supabase Dashboard → **SQL Editor** → paste **`supabase/schema.sql`** → Run (safe to re-run after every update - it only adds missing columns/views). It creates: `processes`, `agents`, `certification_sessions`, `certification_results`, `app_settings`, `email_logs`, the private storage bucket `recordings`, indexes, RLS and a `certification_overview` view.
2. Project Settings → API → copy the **Project URL** and the **service_role (secret) key**.
3. `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
4. Restart. The app now stores everything in Supabase (the SoTrue process is seeded automatically from `data/processes/sotrue.json` the first time the table is empty). Recordings are uploaded to the `recordings` bucket as `<SESSION_ID>/screen.webm` and `audio.webm` and played in the admin panel through signed URLs.

Without Supabase keys the app runs in **JSON-file mode** (`data/*.json`, `recordings/`) — same features, useful for local testing.

> Supabase free plan limits uploads to 50 MB per file; raise it under Project Settings → Storage if long screen recordings fail to upload (the score is still produced).

## Uploads & performance

- **No 413 errors**: recordings are never sent as one big request. In Supabase mode the browser uploads the file **directly to Supabase Storage** through a short-lived signed URL (bypasses your server/proxy limits). Otherwise (or as a fallback) the file is sent in **4 MB chunks** through the server; if a proxy answers 413 the chunk size halves automatically (down to 256 KB) and network/5xx errors are retried. Progress is shown to the agent; a failed upload can be retried without losing the recording.
- **Light screen capture**: max 1920×1080, ~5 fps, VP8 @ 600 kbps (≈ 2–5 MB per minute, perfectly readable for the Gemini video analysis, low CPU so the live call stays responsive).
- **Half-duplex mic** (default on, per-process `live_settings.half_duplex`): while the AI customer is speaking, Gemini receives silence instead of the mic. This stops speaker→mic echo from making the AI interrupt itself and slow down over the call. The mixed conversation recording still contains the real mic audio. Turn-taking is tuned via `realtimeInputConfig` (end-of-speech sensitivity HIGH, 800 ms silence) - overridable per process (`end_of_speech_sensitivity`, `silence_duration_ms`, `prefix_padding_ms`).
- Hosting notes: on Vercel set the function `maxDuration` (already exported as 300 s on the evaluation route; needs a plan that allows it). Supabase free plan limits uploads to 50 MB per file - raise it under Project Settings → Storage for very long calls.

## Scorecard (default, editable per process)

| Section | Sub parameter | Marks |
| --- | --- | --- |
| Opening (7) | Standard Call Opening · Acknowledgement | 5 · 2 |
| Soft Skills (54) | Professionalism **ZTP** · Empathy/Apology/Assurance · ROS/Clarity/Accent · Enthusiasm · Active listening · Grammar · Accurate Probing | 5 · 5 · 10 · 12 · 6 · 10 · 6 |
| Hold Procedure (10) | Hold Procedure · Transfer · Dead Air | 4 · 3 · 3 |
| Tagging (11) | CRM Disposition · Case Escalation | 6 · 5 |
| Resolution (10) | Correct and Complete Information | 10 |
| Closing (8) | Further Assistance · Closing script | 4 · 4 |

- Gemini returns C / NC / NA + marks + reason + verbatim evidence per parameter (strict JSON schema).
- Server clamps marks, verifies evidence against the real transcript, computes section totals, excludes NA from the denominator, and applies **ZTP**: an NC on a zero-tolerance parameter sets the score to 0 and fails the call.
- **Screen recording is analysed by Gemini** (two-stage evaluation): the `screen.webm` is uploaded to the Gemini Files API and Gemini watches the full recording against a **verification checklist built from the process**: portal opened (e.g. Shopify) → the **exact scenario ID searched** (e.g. `order_id: ST12345` from the customer profile; a different ID = fail with the value actually seen) → matching record opened → status/ETA read from the screen → CRM record opened for this customer → disposition selected → remarks added → saved → escalation (if required) → only work apps used. Each check gets `pass / fail / partial / unclear / not_applicable` + timestamp + evidence + value seen, plus a **cross-check**: what the screen showed vs. what the agent told the customer (`consistent / inconsistent`). The scorecard stage uses that: `fail` → NC, `partial` → partial marks, `unclear` → NA; Accurate Probing / Correct Information are corroborated against the screen. The full "Portal & CRM verification" report (verdicts, values seen, timeline, concerns) is on the result page, admin detail, dashboard list and in the result email.
- Evaluation runs in the background (`POST /evaluate` returns 202); the agent page and admin page poll the session and show the stage (uploading video → Gemini processing → watching screen → scoring → emailing). Typical time 1–5 minutes depending on call length.
- Optional env: `SCREEN_ANALYSIS_MODEL` (e.g. `gemini-2.5-pro` for better small-text reading), `SCREEN_MEDIA_RESOLUTION=MEDIA_RESOLUTION_HIGH`. Per process: expected portal/CRM actions (one per line) and an on/off switch for screen analysis.

## Files

```
data/processes/sotrue.json                   default process (seeded into Supabase)
supabase/schema.sql                          run once in Supabase
src/app/admin/*                              admin panel (certifications, processes, agents, email settings)
src/app/certification/[sessionId]/page.jsx   agent page: START -> live AI call -> END -> score
src/lib/server/db/*                          data layer: supabase-repo.js / json-repo.js (same interface)
src/lib/server/gemini.js                     Live token (config locked server-side) + AI customer prompt
src/lib/server/screen-analysis.js            Gemini Files API upload + vision pass over the screen recording
src/lib/server/evaluation.js                 scorecard prompt (transcript + audio + screen report), scoring, groups, ZTP
src/lib/server/evaluation-job.js             background pipeline with persisted stages
src/lib/server/email.js                      SMTP (nodemailer) + invite / result / test templates
src/lib/live/*                               browser: Gemini Live WebSocket, audio engine, screen recorder
```

## API

| Method | Path |
| --- | --- |
| GET | `/api/health` |
| GET/POST | `/api/processes` (`?view=admin`), PUT/DELETE `/api/processes/{id}` |
| GET/POST | `/api/agents`, PUT/DELETE `/api/agents/{id}`, POST `/api/agents/{id}/invite` |
| GET | `/api/certifications`, `/api/certifications/{id}` |
| POST | `/api/certifications/create` `{ process_id, agent_id?, send_email? }` |
| POST | `/api/certifications/{id}/start` · `/transcript` · `/upload-url` · `/upload-chunk` · `/upload-complete` · `/upload-screen` · `/upload-audio` (legacy single request) · `/end` · `/evaluate` · `/resend-invite` · `/resend-result` |
| GET | `/api/certifications/{id}/result`, `/recording?type=screen|audio` |
| POST | `/api/live-token` `{ session_id }` |
| GET/PUT | `/api/settings/email`, POST `/api/settings/email/test` |
| GET | `/api/analytics?process_id=&from=&to=` (overview, sections, parameters, pareto, processes, agents) |
| POST | `/api/certifications/{id}/recertify` `{ send_email?, force? }` |

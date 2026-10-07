"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { DEFAULT_RUBRIC, EVIDENCE_SOURCES, VOICES, rubricGroups, rubricTotal } from "@/lib/rubric";
import { api } from "@/lib/api";

const textareaClass = `${inputClass} min-h-[7rem] leading-relaxed`;

function slugify(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function toForm(p) {
  if (!p) {
    return {
      process_id: "",
      process_name: "",
      tagline: "",
      language: "Hindi/Hinglish",
      active: true,
      customer_name: "",
      scenario_title: "",
      opening_line: "",
      ai_prompt: "",
      evaluator_notes: "",
      voice_name: "Puck",
      max_duration_minutes: 15,
      passing_percentage: 80,
      notification_emails: "",
      expected_portal_actions: "",
      expected_crm_actions: "",
      screen_analysis_enabled: true,
      recert_enabled: true,
      recert_max_attempts: 3,
      recert_cooldown_hours: 0,
      agent_instructions: ["You will interact with an AI customer. Please behave exactly as you would in a real customer call.", "The customer speaks first. Listen carefully and respond naturally.", "Use your normal tools (order portal / CRM) on the shared screen exactly as you would on a live call.", "Click END CERTIFICATION only after you have closed the call properly."].join("\n"),
      rubric: DEFAULT_RUBRIC.map((r) => ({ ...r })),
    };
  }
  return {
    process_id: p.process_id,
    process_name: p.process_name || "",
    tagline: p.tagline || "",
    language: p.language || "Hindi/Hinglish",
    active: p.active !== false,
    customer_name: p.customer_profile?.name || "",
    scenario_title: p.scenario?.title || "",
    opening_line: p.scenario?.opening_line || "",
    ai_prompt: p.ai_prompt || "",
    evaluator_notes: p.evaluator_notes || "",
    voice_name: p.live_settings?.voice_name || "Puck",
    max_duration_minutes: p.live_settings?.max_duration_minutes || 15,
    passing_percentage: p.scoring?.passing_percentage ?? 80,
    notification_emails: (p.notification_emails || []).join(", "),
    expected_portal_actions: (p.expected_portal_actions || []).join("\n"),
    expected_crm_actions: (p.expected_crm_actions || []).join("\n"),
    screen_analysis_enabled: p.screen_analysis?.enabled !== false,
    recert_enabled: p.recertification?.enabled !== false,
    recert_max_attempts: p.recertification?.max_attempts ?? 3,
    recert_cooldown_hours: p.recertification?.cooldown_hours ?? 0,
    agent_instructions: (p.agent_instructions || []).join("\n"),
    rubric: (p.rubric && p.rubric.length ? p.rubric : DEFAULT_RUBRIC).map((r) => ({ ...r })),
  };
}

function toPayload(f) {
  return {
    process_id: f.process_id,
    process_name: f.process_name,
    tagline: f.tagline,
    language: f.language,
    active: f.active,
    customer_name: f.customer_name,
    scenario_title: f.scenario_title,
    opening_line: f.opening_line,
    ai_prompt: f.ai_prompt,
    evaluator_notes: f.evaluator_notes,
    live_settings: { voice_name: f.voice_name, max_duration_minutes: Number(f.max_duration_minutes) || 15 },
    scoring: { passing_percentage: Number(f.passing_percentage) || 0 },
    notification_emails: f.notification_emails,
    expected_portal_actions: f.expected_portal_actions,
    expected_crm_actions: f.expected_crm_actions,
    screen_analysis: { enabled: f.screen_analysis_enabled },
    recertification: { enabled: f.recert_enabled, max_attempts: Number(f.recert_max_attempts) || 3, cooldown_hours: Number(f.recert_cooldown_hours) || 0 },
    agent_instructions: f.agent_instructions,
    rubric: f.rubric,
  };
}

export function promptTemplate(f) {
  const brand = f.process_name || "<Brand>";
  const customer = f.customer_name || "<Customer name>";
  const scenario = f.scenario_title || "<Scenario title>";
  return `You are ${customer}, a real customer of ${brand}. You are calling ${brand} customer support about: ${scenario}.

BACKGROUND (why you are calling):
- <Describe the problem in 2-3 lines, e.g. "I placed an order 5 days ago and it has not been delivered.">

WHAT YOU KNOW (share each fact ONLY when the agent asks - the agent must probe):
- Your name: ${customer}
- <Order ID / account number / registered mobile - give only when asked>
- <Product / plan / amount>
- <Any other detail the agent should ask for>

WHAT YOU DO NOT KNOW (never say this yourself - only the agent can tell you):
- <The real status / root cause, e.g. "the order is delayed and will be delivered within 2 days">

HOW TO RESPOND:
- If the agent asks for <detail>: "<your reply>"
- If the agent asks what the issue is: "<short description of the problem>"
- If the agent gives the CORRECT resolution (<state it>): confirm it back and accept with relief.
- If the agent gives WRONG or contradictory information: politely push back and ask them to check again.
- If the agent tries to close without resolving: ask when/how your issue will be resolved.
- If asked to hold: agree briefly and wait silently.
- After resolution, if asked for further help: "No, that's all. Thank you."

MOOD: <polite but worried / frustrated / in a hurry>. Become a little impatient if the agent is unhelpful or rude, but never abusive.`;
}

export default function ProcessForm({ process = null }) {
  const router = useRouter();
  const isNew = !process;
  const [form, setForm] = useState(() => toForm(process));
  const [idTouched, setIdTouched] = useState(Boolean(process));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const groups = useMemo(() => rubricGroups(form.rubric), [form.rubric]);
  const total = rubricTotal(form.rubric);
  const groupNames = useMemo(() => Array.from(new Set(form.rubric.map((r) => r.group).filter(Boolean))), [form.rubric]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const setName = (value) => setForm((f) => ({ ...f, process_name: value, process_id: isNew && !idTouched ? slugify(value) : f.process_id }));
  const setRow = (index, patch) => setForm((f) => ({ ...f, rubric: f.rubric.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  const removeRow = (index) => setForm((f) => ({ ...f, rubric: f.rubric.filter((_, i) => i !== index) }));
  const addRow = () =>
    setForm((f) => ({
      ...f,
      rubric: [...f.rubric, { id: `P${String(f.rubric.length + 1).padStart(2, "0")}`, group: f.rubric[f.rubric.length - 1]?.group || "General", parameter: "", max_marks: 5, evidence_source: "transcript", zero_tolerance: false, guideline: "" }],
    }));
  const resetRubric = () => {
    if (window.confirm("Replace the rubric with the standard 17-parameter scorecard?")) set("rubric", DEFAULT_RUBRIC.map((r) => ({ ...r })));
  };
  const insertTemplate = () => {
    if (form.ai_prompt.trim() && !window.confirm("Replace the current AI prompt with the example template?")) return;
    set("ai_prompt", promptTemplate(form));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.process_name.trim()) return setError("Process name is required.");
    if (!form.customer_name.trim()) return setError("Customer name is required.");
    if (!form.scenario_title.trim()) return setError("Scenario title is required.");
    if (!form.opening_line.trim()) return setError("Opening line is required - the first sentence the AI customer says.");
    if (!form.ai_prompt.trim()) return setError("AI prompt is required - this is what the AI uses to talk to the agent.");
    if (!form.rubric.length) return setError("Add at least one rubric parameter.");
    if (form.rubric.some((r) => !String(r.parameter).trim())) return setError("Every rubric row needs a parameter name.");
    setSaving(true);
    try {
      const payload = toPayload(form);
      if (isNew) await api.createProcess(payload);
      else await api.updateProcess(process.process_id, payload);
      router.push("/admin/processes");
      router.refresh();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      {error ? (
        <Alert tone="error" title="Please fix the following">
          {error}
        </Alert>
      ) : null}

      <Card title="1. Process" subtitle="Basic details shown to the agent on the certification page.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Process name" required>
            <input className={inputClass} value={form.process_name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SoTrue, Flipkart, Amazon" />
          </Field>
          <Field label="Process ID" hint={isNew ? "Auto-generated from the name. Letters, numbers and _ only." : "Cannot be changed after creation."}>
            <input
              className={`${inputClass} mono`}
              value={form.process_id}
              disabled={!isNew}
              onChange={(e) => {
                setIdTouched(true);
                set("process_id", slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Tagline">
            <input className={inputClass} value={form.tagline} onChange={(e) => set("tagline", e.target.value)} placeholder="e.g. Order / Customer Support Certification" />
          </Field>
          <Field label="Call language" hint="The AI customer speaks in this language.">
            <input className={inputClass} value={form.language} onChange={(e) => set("language", e.target.value)} placeholder="Hindi/Hinglish" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Active (inactive processes cannot start new certifications)
          </label>
        </div>
      </Card>

      <Card title="2. AI customer" subtitle="The AI uses this prompt to talk to the agent - the whole conversation is driven by it.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer name" required>
            <input className={inputClass} value={form.customer_name} onChange={(e) => set("customer_name", e.target.value)} placeholder="e.g. Rahul" />
          </Field>
          <Field label="Scenario title" required>
            <input className={inputClass} value={form.scenario_title} onChange={(e) => set("scenario_title", e.target.value)} placeholder="e.g. Order Not Received" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Opening line (the AI speaks this first)" required hint="Exactly what the customer says when the call connects.">
              <input className={inputClass} value={form.opening_line} onChange={(e) => set("opening_line", e.target.value)} placeholder="e.g. नमस्ते, मुझे अपने ऑर्डर के बारे में कुछ जानकारी चाहिए।" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">
                AI prompt <span className="text-rose-500">*</span>
              </span>
              <button type="button" className="text-xs font-medium text-brand-600 hover:underline" onClick={insertTemplate}>
                Insert example template
              </button>
            </div>
            <textarea className={`${textareaClass} min-h-[18rem] font-mono text-xs`} value={form.ai_prompt} onChange={(e) => set("ai_prompt", e.target.value)} placeholder="Describe who the customer is, the problem, what the customer knows (and reveals only when asked), what the customer does NOT know, how to react to correct / wrong answers, and the mood." />
            <p className="mt-1 text-xs text-slate-500">Tip: write what the customer knows vs. does not know, the questions the agent should ask, the correct resolution, and how to react when the agent is right or wrong. Standard rules (speak first, short replies, never coach, never reveal evaluation) are added automatically.</p>
          </div>
          <Field label="Voice">
            <select className={inputClass} value={form.voice_name} onChange={(e) => set("voice_name", e.target.value)}>
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Maximum call duration (minutes)">
            <input type="number" min={1} max={60} className={inputClass} value={form.max_duration_minutes} onChange={(e) => set("max_duration_minutes", e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card title="3. Evaluation" subtitle="Used only by the AI auditor after the call. Never shown to the agent.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Evaluator notes" hint="Correct resolution, required probing, expected portal/CRM actions, when hold/transfer/escalation is expected.">
              <textarea className={`${textareaClass} min-h-[9rem]`} value={form.evaluator_notes} onChange={(e) => set("evaluator_notes", e.target.value)} placeholder="CORRECT RESOLUTION: ... REQUIRED PROBING: ... EXPECTED PORTAL ACTIONS: ..." />
            </Field>
          </div>
          <Field label="Expected portal actions (one per line)" hint="Gemini watches the screen recording and checks each of these (e.g. Shopify open, order ID searched, status checked).">
            <textarea className={`${textareaClass} min-h-[6rem]`} value={form.expected_portal_actions} onChange={(e) => set("expected_portal_actions", e.target.value)} placeholder={"Shopify open karna\nOrder ID search karna\nOrder details open karna\nOrder status check karna"} />
          </Field>
          <Field label="Expected CRM actions (one per line)" hint="Checked on the screen recording as well - used for the Tagging parameters.">
            <textarea className={`${textareaClass} min-h-[6rem]`} value={form.expected_crm_actions} onChange={(e) => set("expected_crm_actions", e.target.value)} placeholder={"CRM record open karna\nCorrect disposition select karna\nRequired remarks add karna"} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={Boolean(form.screen_analysis_enabled)} onChange={(e) => set("screen_analysis_enabled", e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Analyse the screen recording with Gemini (portal / CRM verification). When off, screen-based parameters are marked NA.
          </label>
          <div className="grid grid-cols-3 gap-3 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={Boolean(form.recert_enabled)} onChange={(e) => set("recert_enabled", e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
              Allow recertification
            </label>
            <Field label="Max attempts per agent">
              <input type="number" min={1} max={20} className={inputClass} value={form.recert_max_attempts} onChange={(e) => set("recert_max_attempts", e.target.value)} disabled={!form.recert_enabled} />
            </Field>
            <Field label="Cooldown between attempts (hours)">
              <input type="number" min={0} max={720} className={inputClass} value={form.recert_cooldown_hours} onChange={(e) => set("recert_cooldown_hours", e.target.value)} disabled={!form.recert_enabled} />
            </Field>
          </div>
          <Field label="Passing percentage">
            <input type="number" min={0} max={100} className={inputClass} value={form.passing_percentage} onChange={(e) => set("passing_percentage", e.target.value)} />
          </Field>
          <Field label="Extra result recipients for this process" hint="Comma separated. Added to the recipients from Email settings.">
            <input className={inputClass} value={form.notification_emails} onChange={(e) => set("notification_emails", e.target.value)} placeholder="teamlead@company.com, qa@company.com" />
          </Field>
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Scorecard parameters</h3>
              <p className="text-xs text-slate-500">
                Grand total <span className={`font-bold ${total === 100 ? "text-emerald-600" : "text-amber-600"}`}>{total}</span>
                {total !== 100 ? " (the standard scorecard totals 100)" : ""} · {groups.map((g) => `${g.group} ${g.max_marks}`).join(" · ")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={addRow}>
                + Add parameter
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={resetRubric}>
                Reset to standard
              </Button>
            </div>
          </div>
          <datalist id="rubric-groups">
            {groupNames.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">ID</th>
                  <th className="px-2 py-2">Section</th>
                  <th className="px-2 py-2">Sub parameter</th>
                  <th className="px-2 py-2">Marks</th>
                  <th className="px-2 py-2">Evidence</th>
                  <th className="px-2 py-2" title="Zero Tolerance Policy - NC fails the whole call">
                    ZTP
                  </th>
                  <th className="px-2 py-2">Guideline for the auditor</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {form.rubric.map((r, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-2 py-1.5">
                      <input className={`${inputClass} mono w-16 px-2 py-1 text-xs`} value={r.id} onChange={(e) => setRow(i, { id: e.target.value.toUpperCase() })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input list="rubric-groups" className={`${inputClass} w-32 px-2 py-1 text-xs`} value={r.group} onChange={(e) => setRow(i, { group: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className={`${inputClass} min-w-[16rem] px-2 py-1 text-xs`} value={r.parameter} onChange={(e) => setRow(i, { parameter: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" min={0} max={100} className={`${inputClass} w-16 px-2 py-1 text-xs`} value={r.max_marks} onChange={(e) => setRow(i, { max_marks: Number(e.target.value) })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <select className={`${inputClass} w-28 px-2 py-1 text-xs`} value={r.evidence_source} onChange={(e) => setRow(i, { evidence_source: e.target.value })}>
                        {EVIDENCE_SOURCES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={Boolean(r.zero_tolerance)} onChange={(e) => setRow(i, { zero_tolerance: e.target.checked })} className="mt-2 h-4 w-4 rounded border-slate-300" />
                    </td>
                    <td className="px-2 py-1.5">
                      <textarea className={`${inputClass} min-h-[2.4rem] min-w-[18rem] px-2 py-1 text-xs`} rows={2} value={r.guideline} onChange={(e) => setRow(i, { guideline: e.target.value })} />
                    </td>
                    <td className="px-2 py-1.5">
                      <button type="button" className="mt-1 text-rose-600 hover:underline" onClick={() => removeRow(i)} title="Remove">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card title="4. Instructions shown to the agent" subtitle="One instruction per line.">
        <textarea className={textareaClass} value={form.agent_instructions} onChange={(e) => set("agent_instructions", e.target.value)} />
      </Card>

      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={() => router.push("/admin/processes")}>
          Cancel
        </Button>
        <Button type="submit" size="lg" loading={saving} disabled={saving}>
          {isNew ? "Create process" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

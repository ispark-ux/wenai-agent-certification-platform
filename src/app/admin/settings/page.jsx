"use client";

import { useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/api";

export default function EmailSettingsPage() {
  const [form, setForm] = useState(null);
  const [passSet, setPassSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getEmailSettings()
      .then((d) => {
        const s = d.settings;
        setForm({ ...s, notify_to: (s.notify_to || []).join(", "), notify_cc: (s.notify_cc || []).join(", "), smtp_pass: "" });
        setPassSet(Boolean(s.smtp_pass_set));
      })
      .catch((err) => setError(err.message));
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const d = await api.saveEmailSettings(form);
      setForm({ ...d.settings, notify_to: (d.settings.notify_to || []).join(", "), notify_cc: (d.settings.notify_cc || []).join(", "), smtp_pass: "" });
      setPassSet(Boolean(d.settings.smtp_pass_set));
      setMessage(d.configured ? "Settings saved. Email is enabled." : "Settings saved. Email is disabled or incomplete (host, from address and the Enable switch are required).");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const d = await api.testEmail(testTo);
      setMessage(`Test email sent to ${d.to.join(", ")}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <AdminShell title="Email settings" subtitle="SMTP details for sending certification links to agents and scorecards to your team.">
      {error ? (
        <Alert tone="error" className="mb-4" title="Error">
          {error}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone="success" className="mb-4">
          {message}
        </Alert>
      ) : null}
      {form ? (
        <form onSubmit={save} className="space-y-6">
          <Card title="SMTP server" subtitle="Works with Gmail (smtp.gmail.com, port 587, app password), Outlook/Office 365, SendGrid, Amazon SES, Zoho, etc.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="SMTP host" required>
                <input className={inputClass} value={form.smtp_host} onChange={(e) => set("smtp_host", e.target.value)} placeholder="smtp.gmail.com" />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Port" required>
                  <input type="number" className={inputClass} value={form.smtp_port} onChange={(e) => set("smtp_port", e.target.value)} />
                </Field>
                <Field label="Encryption">
                  <select className={inputClass} value={form.smtp_secure ? "ssl" : "starttls"} onChange={(e) => set("smtp_secure", e.target.value === "ssl")}>
                    <option value="starttls">STARTTLS (587)</option>
                    <option value="ssl">SSL/TLS (465)</option>
                  </select>
                </Field>
              </div>
              <Field label="Username">
                <input className={inputClass} value={form.smtp_user} onChange={(e) => set("smtp_user", e.target.value)} placeholder="you@company.com" autoComplete="off" />
              </Field>
              <Field label="Password / app password" hint={passSet ? "A password is saved. Leave blank to keep it." : "Required by most providers."}>
                <input type="password" className={inputClass} value={form.smtp_pass} onChange={(e) => set("smtp_pass", e.target.value)} placeholder={passSet ? "••••••••" : ""} autoComplete="new-password" />
              </Field>
              <Field label="From name">
                <input className={inputClass} value={form.from_name} onChange={(e) => set("from_name", e.target.value)} />
              </Field>
              <Field label="From email" required>
                <input type="email" className={inputClass} value={form.from_email} onChange={(e) => set("from_email", e.target.value)} placeholder="certification@company.com" />
              </Field>
              <Field label="Reply-to (optional)">
                <input type="email" className={inputClass} value={form.reply_to} onChange={(e) => set("reply_to", e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
                <input type="checkbox" checked={Boolean(form.smtp_ignore_tls_errors)} onChange={(e) => set("smtp_ignore_tls_errors", e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                Ignore TLS certificate errors (self-signed internal SMTP)
              </label>
            </div>
          </Card>

          <Card title="Notifications" subtitle="When a certification completes, the scorecard is emailed automatically.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Send results To" hint="Comma separated. Process-specific recipients (set on the process) are added automatically.">
                <input className={inputClass} value={form.notify_to} onChange={(e) => set("notify_to", e.target.value)} placeholder="qa@company.com, manager@company.com" />
              </Field>
              <Field label="CC" hint="Comma separated. Also CC'd on certification-link emails.">
                <input className={inputClass} value={form.notify_cc} onChange={(e) => set("notify_cc", e.target.value)} placeholder="trainer@company.com" />
              </Field>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={Boolean(form.email_agent_result)} onChange={(e) => set("email_agent_result", e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                Also email the agent their own scorecard
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={Boolean(form.send_invite_default)} onChange={(e) => set("send_invite_default", e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                Email the link by default when creating a certification for an agent
              </label>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <label className="flex items-center gap-3 text-sm font-semibold text-slate-800">
                <input type="checkbox" checked={Boolean(form.enabled)} onChange={(e) => set("enabled", e.target.checked)} className="h-5 w-5 rounded border-slate-300" />
                Enable email sending
              </label>
              <Button type="submit" size="lg" loading={saving} disabled={saving}>
                Save settings
              </Button>
            </div>
          </Card>

          <Card title="Send a test email" subtitle="Uses the SAVED settings - click Save first.">
            <div className="flex flex-wrap gap-2">
              <input type="email" className={`${inputClass} max-w-sm`} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@company.com" />
              <Button type="button" variant="secondary" onClick={test} loading={testing} disabled={testing || !testTo}>
                Send test
              </Button>
            </div>
          </Card>
        </form>
      ) : (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
    </AdminShell>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";

const NAV = [
  { href: "/admin", label: "Certifications", icon: "▣" },
  { href: "/admin/analytics", label: "Analytics", icon: "▤" },
  { href: "/admin/processes", label: "Processes", icon: "◈" },
  { href: "/admin/agents", label: "Agents", icon: "◉" },
  { href: "/admin/settings", label: "Email settings", icon: "✉" },
];

function Dot({ ok, warn = false }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : warn ? "bg-amber-400" : "bg-rose-400"}`} />;
}

export default function AdminShell({ title, subtitle, actions, children, wide = false }) {
  const pathname = usePathname() || "";
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }));
  }, [pathname]);

  return (
    <div className="min-h-screen lg:flex">
      <aside className="flex w-full flex-col bg-slate-900 text-white lg:min-h-screen lg:w-64">
        <Link href="/admin" className="flex items-center gap-3 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-black">AC</span>
          <span>
            <span className="block text-sm font-bold uppercase tracking-wide">AI Agent Certification</span>
            <span className="block text-xs text-slate-400">Admin panel</span>
          </span>
        </Link>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:px-3">
          {NAV.map((item) => {
            const active = item.href === "/admin" ? pathname === "/admin" || pathname.startsWith("/admin/certification") : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={`flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${active ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}>
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden border-t border-white/10 px-5 py-4 text-xs text-slate-300 lg:block">
          {health ? (
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2">
                <Dot ok={health.database_ok !== false} />
                Storage: <span className="font-semibold text-white">{health.database === "supabase" ? "Supabase" : "JSON files"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Dot ok={Boolean(health.gemini_configured)} />
                Gemini API {health.gemini_configured ? "ready" : "key missing"}
              </li>
              <li className="flex items-center gap-2">
                <Dot ok={Boolean(health.email_configured)} warn={!health.email_configured} />
                Email {health.email_configured ? "enabled" : "not configured"}
              </li>
              {health.database_error ? <li className="mt-2 rounded bg-rose-500/20 p-2 text-[11px] text-rose-200">{health.database_error}</li> : null}
            </ul>
          ) : (
            <span>Checking status…</span>
          )}
        </div>
      </aside>

      <div className="flex-1">
        <header className="border-b border-slate-200 bg-white/90 px-6 py-4 backdrop-blur">
          <div className={`mx-auto flex flex-wrap items-center justify-between gap-3 ${wide ? "" : "max-w-6xl"}`}>
            <div>
              <h1 className="text-xl font-bold text-slate-900">{title}</h1>
              {subtitle ? <p className="text-sm text-slate-500">{subtitle}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          </div>
        </header>
        <main className={`mx-auto px-6 py-6 ${wide ? "" : "max-w-6xl"}`}>{children}</main>
      </div>
    </div>
  );
}

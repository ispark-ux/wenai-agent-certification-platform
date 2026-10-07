"use client";

import Link from "next/link";

export default function Header({ subtitle = "", right = null }) {
  return (
    <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-black text-white shadow-sm">AC</span>
          <span>
            <span className="block text-sm font-bold uppercase tracking-wide text-slate-900">AI Agent Certification</span>
            {subtitle ? <span className="block text-xs text-slate-500">{subtitle}</span> : null}
          </span>
        </Link>
        {right}
      </div>
    </header>
  );
}

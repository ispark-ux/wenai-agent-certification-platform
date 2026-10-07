"use client";

import { memo, useEffect, useRef } from "react";
import { formatDuration } from "@/lib/format";

const Bubble = memo(function Bubble({ speaker, text, offset, partial = false, interrupted = false }) {
  const isAgent = speaker === "Agent";
  return (
    <div className={`fade-up flex ${isAgent ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${isAgent ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm bg-white text-slate-800 ring-1 ring-slate-200"} ${partial ? "opacity-70" : ""}`}>
        <div className={`mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide ${isAgent ? "text-brand-100" : "text-slate-400"}`}>
          <span>{isAgent ? "Agent" : "AI Customer"}</span>
          {offset !== null && offset !== undefined ? <span className="mono font-normal normal-case">{formatDuration(offset)}</span> : null}
          {partial ? <span className="font-normal normal-case italic">speaking…</span> : null}
          {interrupted ? <span className="font-normal normal-case italic">(interrupted)</span> : null}
        </div>
        <p className="whitespace-pre-wrap leading-relaxed">{text}</p>
      </div>
    </div>
  );
});

function Transcript({ entries = [], partialCustomer = "", partialAgent = "", autoScroll = true, emptyText = "Transcript will appear here as the conversation happens.", className = "" }) {
  const containerRef = useRef(null);
  const rafRef = useRef(0);

  // Instant, rAF-throttled scroll - smooth scrolling on every transcription chunk makes the page janky.
  useEffect(() => {
    if (!autoScroll) return undefined;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [entries.length, partialCustomer, partialAgent, autoScroll]);

  const empty = entries.length === 0 && !partialCustomer && !partialAgent;
  return (
    <div ref={containerRef} className={`scroll-thin space-y-3 overflow-y-auto bg-slate-50 p-4 ${className}`}>
      {empty ? <p className="py-8 text-center text-sm text-slate-400">{emptyText}</p> : null}
      {entries.map((e, i) => (
        <Bubble key={`${i}-${e.timestamp}`} speaker={e.speaker} text={e.text} offset={e.offset_seconds} interrupted={e.interrupted} />
      ))}
      {partialCustomer ? <Bubble speaker="Customer" text={partialCustomer} partial /> : null}
      {partialAgent ? <Bubble speaker="Agent" text={partialAgent} partial /> : null}
    </div>
  );
}

export default memo(Transcript);

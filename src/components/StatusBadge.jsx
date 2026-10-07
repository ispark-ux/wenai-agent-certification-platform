import { statusLabel } from "@/lib/format";

const STYLES = {
  created: "bg-slate-100 text-slate-700 ring-slate-200",
  live: "bg-rose-50 text-rose-700 ring-rose-200",
  ended: "bg-amber-50 text-amber-700 ring-amber-200",
  evaluating: "bg-violet-50 text-violet-700 ring-violet-200",
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-100 text-rose-800 ring-rose-300",
  C: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  NC: "bg-rose-50 text-rose-700 ring-rose-200",
  NA: "bg-slate-100 text-slate-600 ring-slate-200",
  pass: "bg-emerald-600 text-white ring-emerald-600",
  fail: "bg-rose-600 text-white ring-rose-600",
};

export default function StatusBadge({ status, label, className = "" }) {
  const style = STYLES[status] || "bg-slate-100 text-slate-700 ring-slate-200";
  const text = label || (["C", "NC", "NA", "pass", "fail"].includes(status) ? status.toUpperCase() : statusLabel(status));
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${style} ${className}`}>
      {status === "live" ? <span className="live-dot inline-block h-2 w-2 rounded-full bg-rose-500" /> : null}
      {text}
    </span>
  );
}

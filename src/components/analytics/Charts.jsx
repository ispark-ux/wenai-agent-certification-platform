"use client";

/** Dependency-free charts (SVG / CSS) for the analytics pages. */

export function toneFor(pctValue, passing = 80) {
  const n = Number(pctValue);
  if (!Number.isFinite(n)) return "bg-slate-300";
  if (n >= passing) return "bg-emerald-500";
  if (n >= passing - 20) return "bg-amber-500";
  return "bg-rose-500";
}

export function textToneFor(pctValue, passing = 80) {
  const n = Number(pctValue);
  if (!Number.isFinite(n)) return "text-slate-400";
  if (n >= passing) return "text-emerald-600";
  if (n >= passing - 20) return "text-amber-600";
  return "text-rose-600";
}

export function Kpi({ label, value, hint, tone = "text-slate-900" }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value ?? "—"}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** Horizontal bars: rows = [{ label, value (0-100 or raw), display, sub, tone }] */
export function BarList({ rows, max = 100, passing = 80, empty = "No data yet." }) {
  if (!rows?.length) return <p className="text-sm text-slate-400">{empty}</p>;
  const top = Math.max(max, ...rows.map((r) => Number(r.value) || 0));
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-700" title={r.label}>
              {r.label}
            </span>
            <span className={`shrink-0 font-semibold ${r.textTone || textToneFor(r.value, passing)}`}>{r.display ?? (r.value === null || r.value === undefined ? "—" : r.value)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${r.tone || toneFor(r.value, passing)}`} style={{ width: `${Math.max(0, Math.min(100, ((Number(r.value) || 0) / top) * 100))}%` }} />
          </div>
          {r.sub ? <p className="mt-0.5 text-[11px] text-slate-400">{r.sub}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Vertical histogram: buckets = [{ label, count }] */
export function Histogram({ buckets, passing = 80 }) {
  const top = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex h-44 items-end gap-2">
      {buckets.map((b) => (
        <div key={b.label} className="flex flex-1 flex-col items-center gap-1">
          <span className="text-xs font-semibold text-slate-700">{b.count}</span>
          <div className="flex w-full flex-1 items-end">
            <div className={`w-full rounded-t-md ${b.min >= passing ? "bg-emerald-500" : b.min >= passing - 20 ? "bg-amber-400" : "bg-rose-400"}`} style={{ height: `${(b.count / top) * 100}%`, minHeight: b.count ? 4 : 0 }} />
          </div>
          <span className="text-[11px] text-slate-500">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Small sparkline for 0-100 scores. */
export function Sparkline({ values, passing = 80, width = 90, height = 26 }) {
  const v = (values || []).filter((x) => Number.isFinite(Number(x)));
  if (!v.length) return <span className="text-xs text-slate-300">—</span>;
  if (v.length === 1) return <span className={`text-xs font-semibold ${textToneFor(v[0], passing)}`}>{v[0]}%</span>;
  const step = width / (v.length - 1);
  const y = (n) => height - 2 - (Math.max(0, Math.min(100, n)) / 100) * (height - 4);
  const pts = v.map((n, i) => `${(i * step).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  const last = v[v.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <line x1="0" x2={width} y1={y(passing)} y2={y(passing)} stroke="#cbd5e1" strokeDasharray="3 3" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke={last >= passing ? "#059669" : "#e11d48"} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {v.map((n, i) => (
        <circle key={i} cx={i * step} cy={y(n)} r="2.2" fill={n >= passing ? "#059669" : "#e11d48"} />
      ))}
    </svg>
  );
}

/** Daily trend: bars = completed count, line = avg score. */
export function TrendChart({ points, passing = 80 }) {
  if (!points?.length) return <p className="text-sm text-slate-400">No completed certifications in this period.</p>;
  const W = 640;
  const H = 180;
  const pad = { l: 30, r: 30, t: 10, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxCount = Math.max(1, ...points.map((p) => p.completed));
  const bw = Math.max(4, Math.min(28, (iw / points.length) * 0.6));
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const yScore = (s) => pad.t + ih - (Math.max(0, Math.min(100, s)) / 100) * ih;
  const line = points
    .map((p, i) => (Number.isFinite(p.avg_score) ? `${x(i).toFixed(1)},${yScore(p.avg_score).toFixed(1)}` : null))
    .filter(Boolean)
    .join(" ");
  const labelEvery = Math.ceil(points.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full">
      <line x1={pad.l} x2={W - pad.r} y1={yScore(passing)} y2={yScore(passing)} stroke="#10b981" strokeDasharray="4 4" strokeWidth="1" />
      <text x={W - pad.r + 2} y={yScore(passing) + 3} className="fill-emerald-600" style={{ fontSize: 9 }}>
        {passing}%
      </text>
      {points.map((p, i) => {
        const h = (p.completed / maxCount) * ih * 0.9;
        return <rect key={p.date} x={x(i) - bw / 2} y={pad.t + ih - h} width={bw} height={h} rx="2" className="fill-brand-200" />;
      })}
      <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth="2" />
      {points.map((p, i) =>
        Number.isFinite(p.avg_score) ? <circle key={`c-${p.date}`} cx={x(i)} cy={yScore(p.avg_score)} r="3" fill={p.avg_score >= passing ? "#059669" : "#e11d48"}><title>{`${p.date}: ${p.completed} completed, avg ${p.avg_score}%, pass ${p.pass_rate}%`}</title></circle> : null
      )}
      {points.map((p, i) =>
        i % labelEvery === 0 ? (
          <text key={`t-${p.date}`} x={x(i)} y={H - 8} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9 }}>
            {p.date.slice(5)}
          </text>
        ) : null
      )}
      <text x={4} y={pad.t + 8} className="fill-slate-400" style={{ fontSize: 9 }}>
        avg %
      </text>
    </svg>
  );
}

/** Classic Pareto chart: bars (desc) + cumulative % line + 80 % reference. */
export function ParetoChart({ data, valueLabel = "Defects" }) {
  const rows = data?.rows || [];
  if (!rows.length) return <p className="text-sm text-slate-400">No defects recorded for this selection - nothing to prioritise.</p>;
  const W = 720;
  const H = 260;
  const pad = { l: 40, r: 40, t: 14, b: 34 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxV = Math.max(...rows.map((r) => r.value));
  const slot = iw / rows.length;
  const bw = Math.max(6, slot * 0.7);
  const xc = (i) => pad.l + slot * i + slot / 2;
  const yV = (v) => pad.t + ih - (v / maxV) * ih;
  const yP = (p) => pad.t + ih - (p / 100) * ih;
  const line = rows.map((r, i) => `${xc(i).toFixed(1)},${yP(r.cumulative_pct).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-72 w-full">
      {[0, 25, 50, 75, 100].map((p) => (
        <g key={p}>
          <line x1={pad.l} x2={W - pad.r} y1={yP(p)} y2={yP(p)} stroke="#f1f5f9" />
          <text x={W - pad.r + 4} y={yP(p) + 3} className="fill-slate-400" style={{ fontSize: 9 }}>
            {p}%
          </text>
        </g>
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={yP(80)} y2={yP(80)} stroke="#f43f5e" strokeDasharray="5 4" strokeWidth="1.2" />
      <text x={pad.l + 4} y={yP(80) - 4} className="fill-rose-500" style={{ fontSize: 9, fontWeight: 700 }}>
        80% line
      </text>
      <text x={4} y={pad.t + 6} className="fill-slate-400" style={{ fontSize: 9 }}>
        {valueLabel}
      </text>
      <text x={4} y={pad.t + 18} className="fill-slate-500" style={{ fontSize: 9, fontWeight: 700 }}>
        {maxV}
      </text>
      {rows.map((r, i) => (
        <g key={r.key || i}>
          <rect x={xc(i) - bw / 2} y={yV(r.value)} width={bw} height={pad.t + ih - yV(r.value)} rx="3" className={r.vital ? "fill-rose-500" : "fill-slate-300"}>
            <title>{`#${r.rank} ${r.label}: ${r.value} (${r.share}%), cumulative ${r.cumulative_pct}%`}</title>
          </rect>
          <text x={xc(i)} y={H - 18} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 10, fontWeight: 600 }}>
            {r.key && String(r.key).length <= 6 ? r.key : r.rank}
          </text>
        </g>
      ))}
      <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth="2.2" />
      {rows.map((r, i) => (
        <circle key={`p-${i}`} cx={xc(i)} cy={yP(r.cumulative_pct)} r="3" fill="#4f46e5" />
      ))}
    </svg>
  );
}

export function downloadCsv(filename, rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(" | ") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === "function" ? c.value(r) : r[c.value])).join(",")).join("\n");
  const blob = new Blob([`\ufeff${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { agentKeyOf } from "./sessions";

/**
 * Analytics engine (pure - no I/O). Inputs: lite sessions, slim results,
 * processes, registered agents and filters. Output:
 *   overview     KPIs, score distribution, daily trend
 *   sections     section-wise performance (Opening, Soft Skills, ...)
 *   parameters   parameter-wise C / NC / NA, compliance, marks lost
 *   pareto       80/20 analysis of defects (parameters, sections, screen checks)
 *   screen       portal / CRM verification statistics
 *   processes    process-wise analysis
 *   agents       agent-wise analysis incl. attempts and recertification eligibility
 */

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const pct = (a, b) => (b > 0 ? r1((a / b) * 100) : null);
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function eventDate(s) {
  return s.result_summary?.evaluated_at || s.ended_at || s.started_at || s.created_at;
}

const BUCKETS = [
  { label: "0–39", min: 0, max: 40 },
  { label: "40–59", min: 40, max: 60 },
  { label: "60–69", min: 60, max: 70 },
  { label: "70–79", min: 70, max: 80 },
  { label: "80–89", min: 80, max: 90 },
  { label: "90–100", min: 90, max: 100.01 },
];

/** Pareto ordering: sort desc by value, cumulative %, "vital few" up to (and incl.) the item crossing 80 %. */
export function paretoize(items, metric) {
  const rows = items.filter((i) => Number(i[metric]) > 0).sort((a, b) => b[metric] - a[metric]);
  const total = rows.reduce((s, r) => s + r[metric], 0);
  let cum = 0;
  let crossed = false;
  const out = rows.map((r, i) => {
    cum += r[metric];
    const cumulative = total ? (cum / total) * 100 : 0;
    const vital = !crossed;
    if (cumulative >= 80) crossed = true;
    return { ...r, rank: i + 1, value: r[metric], share: r1((r[metric] / total) * 100), cumulative_pct: r1(cumulative), vital };
  });
  return { metric, total, vital_count: out.filter((r) => r.vital).length, item_count: out.length, rows: out };
}

function emptyParam(p) {
  return { id: p.id, parameter: p.parameter, group: p.group || "General", max_marks: p.max_marks || 0, zero_tolerance: Boolean(p.zero_tolerance), evaluated: 0, C: 0, NC: 0, NA: 0, defects: 0, marks_lost: 0, applicable_marks: 0, earned: 0 };
}

function addParam(stat, p) {
  stat.evaluated += 1;
  if (p.status === "C") stat.C += 1;
  else if (p.status === "NC") stat.NC += 1;
  else stat.NA += 1;
  if (p.status !== "NA") {
    const max = Number(p.max_marks) || 0;
    const marks = Math.max(0, Math.min(max, Number(p.marks) || 0));
    stat.applicable_marks += max;
    stat.earned += marks;
    stat.marks_lost += max - marks;
    if (p.status === "NC" || marks < max) stat.defects += 1;
  }
}

function finishParam(stat) {
  return { ...stat, compliance_pct: pct(stat.earned, stat.applicable_marks), nc_rate: pct(stat.NC, stat.C + stat.NC), na_rate: pct(stat.NA, stat.evaluated) };
}

function aggregate(records) {
  const params = new Map();
  const groups = new Map();
  const checks = new Map();
  const screen = { analysed: 0, portal: {}, crm: {}, consistency: {} };
  for (const rec of records) {
    for (const p of rec.result.parameters || []) {
      const key = p.id;
      if (!params.has(key)) params.set(key, emptyParam(p));
      addParam(params.get(key), p);
    }
    for (const g of rec.result.groups || []) {
      if (!groups.has(g.group)) groups.set(g.group, { group: g.group, max_marks: g.max_marks || 0, marks: 0, applicable_marks: 0, evaluated: 0, all_na: 0 });
      const e = groups.get(g.group);
      e.evaluated += 1;
      e.marks += Number(g.marks) || 0;
      e.applicable_marks += Number(g.applicable_marks) || 0;
      if (!g.applicable_marks) e.all_na += 1;
    }
    const sa = rec.result.screen_analysis;
    if (sa && sa.analyzed) {
      screen.analysed += 1;
      const pv = sa.portal_verdict || rec.result.evidence_sources?.screen_portal_verdict || "unclear";
      const cv = sa.crm_verdict || rec.result.evidence_sources?.screen_crm_verdict || "unclear";
      const cc = sa.cross_check?.consistency || rec.result.evidence_sources?.screen_consistency || "unclear";
      screen.portal[pv] = (screen.portal[pv] || 0) + 1;
      screen.crm[cv] = (screen.crm[cv] || 0) + 1;
      screen.consistency[cc] = (screen.consistency[cc] || 0) + 1;
      for (const v of sa.verification || []) {
        const key = v.title || v.id;
        if (!checks.has(key)) checks.set(key, { id: v.id, title: key, category: v.category || "other", pass: 0, fail: 0, partial: 0, unclear: 0, not_applicable: 0, defects: 0 });
        const c = checks.get(key);
        c[v.result] = (c[v.result] || 0) + 1;
        if (v.result === "fail" || v.result === "partial") c.defects += 1;
      }
    }
  }
  const parameters = Array.from(params.values()).map(finishParam);
  const sections = Array.from(groups.values()).map((g) => ({ ...g, marks_lost: g.applicable_marks - g.marks, percentage: pct(g.marks, g.applicable_marks), na_rate: pct(g.all_na, g.evaluated) }));
  const screenChecks = Array.from(checks.values()).map((c) => ({ ...c, pass_rate: pct(c.pass, c.pass + c.fail + c.partial) }));
  return { parameters, sections, screen: { ...screen, checks: screenChecks } };
}

function scoreStats(records) {
  const scores = records.map((r) => Number(r.result.percentage)).filter(Number.isFinite);
  const passed = records.filter((r) => r.result.passed).length;
  const durations = records.map((r) => Number(r.session.duration_seconds)).filter((d) => Number.isFinite(d) && d > 0);
  return {
    completed: records.length,
    passed,
    failed: records.length - passed,
    pass_rate: pct(passed, records.length),
    avg_score: r1(avg(scores)),
    median_score: r1(median(scores)),
    min_score: scores.length ? r1(Math.min(...scores)) : null,
    max_score: scores.length ? r1(Math.max(...scores)) : null,
    avg_duration_seconds: durations.length ? Math.round(avg(durations)) : null,
    ztp_failures: records.filter((r) => r.result.ztp_failed).length,
  };
}

function trendOf(records, days) {
  const buckets = new Map();
  for (const r of records) {
    const d = String(eventDate(r.session) || "").slice(0, 10);
    if (!d) continue;
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(r);
  }
  const keys = Array.from(buckets.keys()).sort().slice(-Math.max(7, days || 60));
  return keys.map((k) => {
    const list = buckets.get(k);
    const st = scoreStats(list);
    return { date: k, completed: st.completed, avg_score: st.avg_score, pass_rate: st.pass_rate };
  });
}

function distributionOf(records) {
  return BUCKETS.map((b) => ({ label: b.label, min: b.min, count: records.filter((r) => Number(r.result.percentage) >= b.min && Number(r.result.percentage) < b.max).length }));
}

function paretoSet(agg) {
  return {
    parameters_by_defects: paretoize(agg.parameters.map((p) => ({ key: p.id, label: p.parameter, group: p.group, defects: p.defects, marks_lost: p.marks_lost, NC: p.NC })), "defects"),
    parameters_by_marks: paretoize(agg.parameters.map((p) => ({ key: p.id, label: p.parameter, group: p.group, defects: p.defects, marks_lost: p.marks_lost, NC: p.NC })), "marks_lost"),
    sections_by_marks: paretoize(agg.sections.map((g) => ({ key: g.group, label: g.group, marks_lost: g.marks_lost })), "marks_lost"),
    screen_checks: paretoize(agg.screen.checks.map((c) => ({ key: c.id, label: c.title, group: c.category, defects: c.defects })), "defects"),
  };
}

export function computeAnalytics({ sessions = [], results = [], processes = [], agents = [], filters = {} }) {
  const fromTs = filters.from ? new Date(filters.from).getTime() : null;
  const toTs = filters.to ? new Date(filters.to).getTime() : null;
  const inRange = (s) => {
    const t = new Date(eventDate(s)).getTime();
    if (!Number.isFinite(t)) return true;
    return (fromTs === null || t >= fromTs) && (toTs === null || t <= toTs);
  };
  const processById = new Map(processes.map((p) => [p.process_id, p]));
  const resultById = new Map(results.map((r) => [r.session_id, r]));

  const scoped = sessions.filter((s) => (!filters.process_id || s.process_id === filters.process_id) && inRange(s));
  const records = scoped.filter((s) => s.status === "completed" && resultById.has(s.session_id)).map((s) => ({ session: s, result: resultById.get(s.session_id) }));

  // ---------------- overview
  const stats = scoreStats(records);
  const statusCount = (st) => scoped.filter((s) => s.status === st).length;
  const first = records.filter((r) => (r.session.attempt_no || 1) === 1);
  const recerts = records.filter((r) => (r.session.attempt_no || 1) > 1);
  const agg = aggregate(records);

  // ---------------- agents
  const agentMap = new Map();
  for (const s of scoped) {
    const key = agentKeyOf(s);
    if (!key) continue;
    if (!agentMap.has(key)) agentMap.set(key, { key, sessions: [] });
    agentMap.get(key).sessions.push(s);
  }
  const registeredByKey = new Map(agents.map((a) => [agentKeyOf({ agent_id: a.id }), a]));
  const agentRows = [];
  for (const { key, sessions: list } of agentMap.values()) {
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const done = list.filter((s) => s.status === "completed" && resultById.has(s.session_id)).map((s) => ({ session: s, result: resultById.get(s.session_id) }));
    const latestDone = done[done.length - 1] || null;
    const latestAny = list[list.length - 1];
    const reg = registeredByKey.get(key);
    const processId = latestAny.process_id;
    const proc = processById.get(processId);
    const rules = { max_attempts: Number(proc?.recertification?.max_attempts) > 0 ? Number(proc.recertification.max_attempts) : 3, enabled: proc?.recertification?.enabled !== false };
    const certified = done.some((d) => d.result.passed);
    const inProgress = list.some((s) => ["live", "ended", "evaluating"].includes(s.status));
    const pendingLink = list.some((s) => s.status === "created");
    const scores = done.map((d) => Number(d.result.percentage)).filter(Number.isFinite);
    const focus = latestDone
      ? (latestDone.result.parameters || [])
          .filter((p) => p.status !== "NA" && Number(p.marks) < Number(p.max_marks))
          .map((p) => ({ id: p.id, parameter: p.parameter, lost: Number(p.max_marks) - Number(p.marks) }))
          .sort((a, b) => b.lost - a.lost)
          .slice(0, 3)
      : [];
    let status = "Not started";
    if (certified) status = "Certified";
    else if (inProgress) status = "In progress";
    else if (done.length) status = latestDone?.result.ztp_failed ? "Failed (ZTP)" : "Not certified";
    else if (pendingLink) status = "Link sent";
    const eligible = !certified && done.length > 0 && !inProgress && rules.enabled && done.length < rules.max_attempts;
    agentRows.push({
      key,
      agent_id: latestAny.agent_id || reg?.id || null,
      name: latestAny.agent_name || reg?.name || "—",
      email: latestAny.agent_email || reg?.email || null,
      employee_id: latestAny.employee_id || reg?.employee_id || null,
      process_id: processId,
      process_name: latestAny.process_name || proc?.process_name || processId,
      total_links: list.length,
      attempts: done.length,
      max_attempts: rules.max_attempts,
      certified,
      status,
      latest_score: latestDone ? r1(Number(latestDone.result.percentage)) : null,
      best_score: scores.length ? r1(Math.max(...scores)) : null,
      first_score: scores.length ? r1(scores[0]) : null,
      avg_score: r1(avg(scores)),
      improvement: scores.length > 1 ? r1(scores[scores.length - 1] - scores[0]) : null,
      trend: scores.map(r1),
      ztp_failures: done.filter((d) => d.result.ztp_failed).length,
      latest_session_id: latestDone?.session.session_id || latestAny.session_id,
      last_activity: eventDate(latestAny),
      focus_areas: focus,
      recertification_eligible: eligible,
      attempts_list: list.map((s) => ({ session_id: s.session_id, attempt_no: s.attempt_no || 1, status: s.status, date: eventDate(s), percentage: resultById.get(s.session_id)?.percentage ?? null, passed: resultById.get(s.session_id)?.passed ?? null })),
    });
  }
  // registered agents who never got a link
  for (const a of agents) {
    if (filters.process_id && a.process_id !== filters.process_id) continue;
    const key = agentKeyOf({ agent_id: a.id });
    if (agentMap.has(key)) continue;
    const proc = processById.get(a.process_id);
    agentRows.push({ key, agent_id: a.id, name: a.name, email: a.email, employee_id: a.employee_id, process_id: a.process_id, process_name: proc?.process_name || a.process_id || "—", total_links: 0, attempts: 0, max_attempts: Number(proc?.recertification?.max_attempts) || 3, certified: false, status: "Not started", latest_score: null, best_score: null, first_score: null, avg_score: null, improvement: null, trend: [], ztp_failures: 0, latest_session_id: null, last_activity: a.created_at, focus_areas: [], recertification_eligible: false, attempts_list: [] });
  }
  agentRows.sort((a, b) => String(b.last_activity || "").localeCompare(String(a.last_activity || "")));

  const agentsWithAttempts = agentRows.filter((a) => a.attempts > 0);
  const firstFailed = agentsWithAttempts.filter((a) => a.attempts_list.find((x) => x.passed !== null)?.passed === false);
  const recovered = firstFailed.filter((a) => a.certified);

  // ---------------- processes
  const processIds = new Set([...processes.map((p) => p.process_id), ...scoped.map((s) => s.process_id).filter(Boolean)]);
  const processRows = Array.from(processIds)
    .filter((id) => !filters.process_id || id === filters.process_id)
    .map((id) => {
      const proc = processById.get(id);
      const recs = records.filter((r) => r.session.process_id === id);
      const links = scoped.filter((s) => s.process_id === id);
      const pAgg = aggregate(recs);
      const pAgents = agentRows.filter((a) => a.process_id === id);
      const st = scoreStats(recs);
      return {
        process_id: id,
        process_name: proc?.process_name || links[0]?.process_name || id,
        scenario_title: proc?.scenario?.title || links[0]?.scenario_title || "",
        active: proc ? proc.active !== false : false,
        passing_percentage: proc?.scoring?.passing_percentage ?? 80,
        links: links.length,
        pending: links.filter((s) => ["created", "live", "ended", "evaluating"].includes(s.status)).length,
        errors: links.filter((s) => s.status === "error").length,
        ...st,
        agents: pAgents.length,
        certified_agents: pAgents.filter((a) => a.certified).length,
        certification_rate: pct(pAgents.filter((a) => a.certified).length, pAgents.filter((a) => a.attempts > 0).length),
        sections: pAgg.sections,
        top_defects: paretoize(pAgg.parameters.map((p) => ({ key: p.id, label: p.parameter, group: p.group, marks_lost: p.marks_lost, defects: p.defects })), "marks_lost").rows.slice(0, 5),
        screen: { analysed: pAgg.screen.analysed, portal: pAgg.screen.portal, crm: pAgg.screen.crm },
        trend: trendOf(recs, 30),
      };
    })
    .sort((a, b) => b.links - a.links);

  return {
    generated_at: new Date().toISOString(),
    filters,
    overview: {
      links: scoped.length,
      created: statusCount("created"),
      in_progress: statusCount("live") + statusCount("ended") + statusCount("evaluating"),
      errors: statusCount("error"),
      ...stats,
      first_attempt: { completed: first.length, pass_rate: pct(first.filter((r) => r.result.passed).length, first.length), avg_score: r1(avg(first.map((r) => Number(r.result.percentage)))) },
      recertifications: { completed: recerts.length, pass_rate: pct(recerts.filter((r) => r.result.passed).length, recerts.length), avg_score: r1(avg(recerts.map((r) => Number(r.result.percentage)))) },
      agents_total: agentRows.length,
      agents_certified: agentRows.filter((a) => a.certified).length,
      agents_pending_recert: agentRows.filter((a) => a.recertification_eligible).length,
      recovery_rate: pct(recovered.length, firstFailed.length),
      distribution: distributionOf(records),
      trend: trendOf(records, 60),
    },
    sections: agg.sections,
    parameters: agg.parameters.sort((a, b) => b.marks_lost - a.marks_lost),
    screen: agg.screen,
    pareto: paretoSet(agg),
    processes: processRows,
    agents: agentRows,
  };
}

// The annual quality plan and the improvement projects (PDSA).
// Plan: one year's goals, each tied to a chapter or standard, an indicator or a project, an owner and a quarter.
// A goal's status is worked out: achieved (marked done, its project done, or its indicator on target), late (its
// quarter is over), behind (its indicator below target), else on track. The quality manager approves the year.
// PDSA: a problem, an aim, a team and an indicator (baseline and target), then Plan-Do-Study-Act cycles, each with a
// due date that reminds the leader. Suggested from an indicator below target 3 periods running, a high risk, or
// repeated incidents of one type.
import { readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { sendPush } from '../lib/push.js';
import { escHtml, fail, json, nowIso, optDate, str, todayIn } from '../lib/util.js';
import { plusDays } from './docs.js';
import { kpiMet, kpiValue } from './kpis.js';
import { SUGGEST_DAYS, SUGGEST_MIN, riskRole } from './risk.js';

export const PDSA_ACTS = ['adopt', 'adapt', 'abandon'];
export const PDSA_STATUS = ['active', 'done', 'stopped'];
// Periods below target in a row that suggest a project.
export const PDSA_BELOW_RUN = 3;
const QUARTER_END = ['03-31', '06-30', '09-30', '12-31'];
const MAX_CYCLES = 20;

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const teamOf = (p) => String((p && p.team) || '').split(',').map(Number).filter((x) => x > 0);
const numOrNull = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
export const quarterEnd = (year, q) => `${year}-${QUARTER_END[q - 1]}`;

export async function planAccess(env, u) {
  const r = riskRole(u);
  if (r.manager) return 'manager';
  if (r.officer) return 'officer';
  if (r.viewer) return 'viewer';
  if (r.dept) return 'dept';
  const x = await env.DB.prepare(
    "SELECT 1 AS x FROM quality_goals WHERE owner_id = ?1 UNION SELECT 1 FROM pdsa WHERE status = 'active' AND (leader_id = ?1 OR team LIKE '%,' || CAST(?1 AS INTEGER) || ',%') LIMIT 1",
  ).bind(u.id).first();
  return x ? 'member' : 'none';
}

/* ------------------------------ notifications ------------------------------ */

const MAIL = {
  ar: {
    dir: 'rtl',
    kind: { team: 'أُضفت إلى مشروع تحسين', cycle: 'تذكير: موعد دورة تحسين', goal: 'أصبحت مسؤولاً عن هدف في خطة الجودة' },
    labels: { due: 'الموعد', cycle: 'الدورة' },
    open: 'فتح',
    footer: (app) => `رسالة تلقائية من ${app}.`,
  },
  en: {
    dir: 'ltr',
    kind: { team: 'You were added to an improvement project', cycle: 'Reminder: improvement cycle due', goal: 'You own a goal in the quality plan' },
    labels: { due: 'Due', cycle: 'Cycle' },
    open: 'Open',
    footer: (app) => `Automatic message from ${app}.`,
  },
};

async function notify(env, settings, userIds, kind, x) {
  const ids = [...new Set(userIds.filter((v) => Number.isInteger(v) && v > 0))];
  if (!ids.length) return;
  const { results: people } = await env.DB.prepare(`SELECT id, email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const path = x.path;
  const jobs = [];
  if (people.length && mailReady(settings)) {
    const mail = bothLangs(settings, (s) => {
      const L = MAIL[s.email_lang === 'en' ? 'en' : 'ar'];
      const app = appName(s, s.email_lang);
      const align = L.dir === 'rtl' ? 'right' : 'left';
      const row = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#6e6553;text-align:${align}">${escHtml(L.labels[k])}</td><td style="padding:4px 10px;text-align:${align}">${escHtml(String(v))}</td></tr>` : '');
      const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
        <p style="font-size:16px;font-weight:bold">${escHtml(L.kind[kind])} ${x.code ? `<span dir="ltr">${escHtml(x.code)}</span>` : ''}</p>
        <p>${escHtml(x.title)}</p>
        <table style="border-collapse:collapse">${row('cycle', x.cycle)}${row('due', x.due)}</table>
        <p style="margin:20px 0"><a href="${escHtml((s.site_url || '') + path)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
      return { subject: `${L.kind[kind]}${x.code ? ' ' + x.code : ''} - ${app}`, html };
    });
    jobs.push(sendMail(settings, people.map((p) => ({ to: p.email, ...mail }))));
  }
  jobs.push(
    sendPush(env, ids, (lang) => {
      const L = MAIL[lang === 'en' ? 'en' : 'ar'];
      return { title: L.kind[kind] + (x.code ? ' ' + x.code : ''), body: x.title, url: path, tag: 'qplan-' + kind + '-' + (x.id || '') };
    }),
  );
  await Promise.all(jobs.map((p) => p.catch((e) => console.error('qplan notify', e))));
}

const managerIds = async (env) => (await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role = 'manager'").all()).results.map((r) => r.id);

/* --------------------------------- shared --------------------------------- */

async function people(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.name_en, u.department_id, d.name_ar AS dept_ar, d.name_en AS dept_en FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.active = 1 AND u.id <> (SELECT MIN(id) FROM users) ORDER BY u.name`,
  ).all();
  return results;
}

// Each indicator with its latest value (and whether it meets the target).
export async function kpisLatest(env) {
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.code, k.name_ar, k.name_en, k.unit, k.direction, k.target, k.frequency, k.active, v.period, v.num, v.den
       FROM kpis k LEFT JOIN kpi_values v ON v.kpi_id = k.id AND v.period = (SELECT MAX(period) FROM kpi_values WHERE kpi_id = k.id)
      ORDER BY k.code`,
  ).all();
  return results.map((k) => {
    const value = k.period ? kpiValue(k, k.num, k.den) : null;
    return { id: k.id, code: k.code, name_ar: k.name_ar, name_en: k.name_en, unit: k.unit, direction: k.direction, target: k.target, active: k.active, period: k.period || null, value, met: kpiMet(k, value) };
  });
}

// A goal's status from what it is tied to.
export function goalStatus(g, kpi, pdsa, today) {
  if (g.progress === 'dropped') return 'dropped';
  if (g.progress === 'done' || (pdsa && pdsa.status === 'done') || (kpi && kpi.met === true)) return 'achieved';
  if (quarterEnd(g.year, g.quarter) < today) return 'late';
  if (kpi && kpi.met === false) return 'behind';
  return 'on_track';
}

const GSELECT = `SELECT g.*, d.name_ar AS dept_ar, d.name_en AS dept_en, u.name AS owner_name, u.name_en AS owner_name_en
  FROM quality_goals g LEFT JOIN departments d ON d.id = g.department_id LEFT JOIN users u ON u.id = g.owner_id`;

// The goals of one year with their status (for the plan page and the quality report).
export async function yearGoals(env, year, today, where, args) {
  const [{ results }, kpis, { results: projects }] = await Promise.all([
    env.DB.prepare(`${GSELECT} WHERE g.year = ?${where ? ' AND (' + where + ')' : ''} ORDER BY g.quarter, g.id`).bind(year, ...(args || [])).all(),
    kpisLatest(env),
    env.DB.prepare('SELECT id, code, title, status FROM pdsa').all(),
  ]);
  const K = Object.fromEntries(kpis.map((k) => [k.id, k]));
  const P = Object.fromEntries(projects.map((p) => [p.id, p]));
  return results.map((g) => {
    const kpi = g.kpi_id ? K[g.kpi_id] || null : null;
    const pdsa = g.pdsa_id ? P[g.pdsa_id] || null : null;
    return {
      id: g.id, year: g.year, title: g.title, detail: g.detail || '', chapter: g.chapter || '', std_code: g.std_code || '', quarter: g.quarter, measure: g.measure || '',
      department_id: g.department_id, dept_ar: g.dept_ar || '', dept_en: g.dept_en || '', owner_id: g.owner_id, owner_name: g.owner_name || '', owner_name_en: g.owner_name_en || '',
      kpi_id: g.kpi_id, kpi, pdsa_id: g.pdsa_id, pdsa, progress: g.progress || '', note: g.note || '', updated_at: g.updated_at,
      status: goalStatus(g, kpi, pdsa, today),
    };
  });
}

/* ---------------------------------- the plan ---------------------------------- */

export async function handlePlan(request, env, url, seg, method, user, ctx) {
  const role = riskRole(user);
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
  // A department head or the goal's owner updates its progress; quality changes everything.
  const canUpdate = (g) => role.officer || (role.dept && g.department_id === role.dept) || g.owner_id === user.id;

  if (method === 'GET' && seg.length === 1) {
    const year = /^\d{4}$/.test(url.searchParams.get('year') || '') ? Number(url.searchParams.get('year')) : Number(today.slice(0, 4));
    const where = role.viewer ? '' : role.dept ? 'g.department_id = ? OR g.owner_id = ?' : 'g.owner_id = ?';
    const args = role.viewer ? [] : role.dept ? [role.dept, user.id] : [user.id];
    const [goals, plan, { results: years }, { results: chapters }, { results: departments }, kpis, { results: projects }] = await Promise.all([
      yearGoals(env, year, today, where, args),
      env.DB.prepare('SELECT * FROM quality_plans WHERE year = ?').bind(year).first(),
      env.DB.prepare('SELECT DISTINCT year FROM quality_goals UNION SELECT year FROM quality_plans ORDER BY 1').all(),
      env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' AND active = 1 ORDER BY sort, code").all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
      kpisLatest(env),
      env.DB.prepare("SELECT id, code, title, status FROM pdsa WHERE status <> 'stopped' ORDER BY id DESC LIMIT 300").all(),
    ]);
    const cur = Number(today.slice(0, 4));
    const yrs = [...new Set([cur - 1, cur, cur + 1, ...years.map((y) => Number(y.year))])].sort();
    return json({
      year, years: yrs, today,
      plan: plan ? { status: plan.status, approved_by: plan.approved_by || '', approved_at: plan.approved_at } : { status: 'draft' },
      goals: goals.map((g) => ({ ...g, can_edit: role.officer, can_update: canUpdate(g) })),
      chapters, departments, kpis: kpis.filter((k) => k.active), projects,
      people: role.officer ? await people(env) : [],
      role: { manager: role.manager, officer: role.officer, viewer: role.viewer, dept: role.dept },
    });
  }

  // POST /plan/approve {year, approved}: the quality manager approves the year's plan (or opens it again).
  if (method === 'POST' && seg[1] === 'approve' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    const b = await readJson(request);
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, 'plan_bad_year');
    const ok = b.approved !== false;
    if (ok && !(await env.DB.prepare('SELECT 1 AS x FROM quality_goals WHERE year = ?').bind(year).first())) fail(400, 'plan_empty');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO quality_plans (year, status, approved_by, approved_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (year) DO UPDATE SET status = excluded.status, approved_by = excluded.approved_by, approved_at = excluded.approved_at, updated_at = excluded.updated_at',
      ).bind(year, ok ? 'approved' : 'draft', ok ? user.name : null, ok ? now : null, now),
      logStmt(env, user, ok ? 'approve' : 'reopen', 'quality_plan', year, String(year)),
    ]);
    return json({ ok: true });
  }

  if (seg[1] !== 'goals') fail(404, 'not_found');

  const readGoal = async (old) => {
    const b = await readJson(request);
    const keep = (k, f) => (b[k] === undefined && old ? old[k] : f(b[k]));
    const n = {
      year: keep('year', (v) => Number(v)),
      title: keep('title', (v) => str(v, 300)),
      detail: keep('detail', (v) => str(v, 2000) || null),
      chapter: keep('chapter', (v) => str(v, 6).toUpperCase() || null),
      std_code: keep('std_code', (v) => str(v, 30).replace(/\s+/g, '').toUpperCase() || null),
      quarter: keep('quarter', (v) => Number(v)),
      measure: keep('measure', (v) => str(v, 300) || null),
      department_id: keep('department_id', toId),
      owner_id: keep('owner_id', toId),
      kpi_id: keep('kpi_id', toId),
      pdsa_id: keep('pdsa_id', toId),
    };
    if (!n.title) fail(400, 'name_required');
    if (!Number.isInteger(n.year) || n.year < 2000 || n.year > 2100) fail(400, 'plan_bad_year');
    if (![1, 2, 3, 4].includes(n.quarter)) fail(400, 'plan_bad_quarter');
    if (n.chapter && !(await env.DB.prepare("SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?").bind(n.chapter).first())) fail(400, 'std_bad_chapter');
    if (n.department_id && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(n.department_id).first())) fail(400, 'invalid_department');
    if (n.owner_id && !(await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(n.owner_id).first())) fail(400, 'invalid_user');
    if (n.kpi_id && !(await env.DB.prepare('SELECT id FROM kpis WHERE id = ?').bind(n.kpi_id).first())) fail(400, 'not_found');
    if (n.pdsa_id && !(await env.DB.prepare('SELECT id FROM pdsa WHERE id = ?').bind(n.pdsa_id).first())) fail(400, 'not_found');
    return n;
  };

  if (method === 'POST' && seg.length === 2) {
    if (!role.officer) fail(403, 'forbidden');
    const n = await readGoal(null);
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO quality_goals (year, title, detail, chapter, std_code, quarter, measure, department_id, owner_id, kpi_id, pdsa_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(n.year, n.title, n.detail, n.chapter, n.std_code, n.quarter, n.measure, n.department_id, n.owner_id, n.kpi_id, n.pdsa_id, user.name, now, now).run();
    const id = res.meta.last_row_id;
    await logStmt(env, user, 'create', 'quality_goal', id, n.title).run();
    if (n.owner_id && n.owner_id !== user.id) later(notify(env, settings, [n.owner_id], 'goal', { id, title: n.title, due: quarterEnd(n.year, n.quarter), path: '/#/quality/qplan' }));
    return json({ ok: true, id });
  }

  const id = toId(seg[2]);
  const old = id ? await env.DB.prepare('SELECT * FROM quality_goals WHERE id = ?').bind(id).first() : null;
  if (!old || !(role.viewer || canUpdate(old))) fail(404, 'not_found');

  if (method === 'PUT' && seg.length === 3) {
    if (!role.officer) fail(403, 'forbidden');
    const n = await readGoal(old);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE quality_goals SET year = ?, title = ?, detail = ?, chapter = ?, std_code = ?, quarter = ?, measure = ?, department_id = ?, owner_id = ?, kpi_id = ?, pdsa_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(n.year, n.title, n.detail, n.chapter, n.std_code, n.quarter, n.measure, n.department_id, n.owner_id, n.kpi_id, n.pdsa_id, nowIso(), id),
      logStmt(env, user, 'update', 'quality_goal', id, n.title),
    ]);
    if (n.owner_id && n.owner_id !== old.owner_id && n.owner_id !== user.id) later(notify(env, settings, [n.owner_id], 'goal', { id, title: n.title, due: quarterEnd(n.year, n.quarter), path: '/#/quality/qplan' }));
    return json({ ok: true });
  }

  // POST /plan/goals/<id>/progress {progress: '' | done | dropped, note}: the department or the owner reports on it.
  if (method === 'POST' && seg[3] === 'progress' && seg.length === 4) {
    if (!canUpdate(old)) fail(403, 'forbidden');
    const b = await readJson(request);
    const progress = ['done', 'dropped'].includes(b.progress) ? b.progress : null;
    // Only quality drops a goal.
    if (progress === 'dropped' && !role.officer) fail(403, 'forbidden');
    const note = b.note === undefined ? old.note : str(b.note, 2000) || null;
    await env.DB.batch([
      env.DB.prepare('UPDATE quality_goals SET progress = ?, note = ?, updated_at = ? WHERE id = ?').bind(progress, note, nowIso(), id),
      logStmt(env, user, 'progress', 'quality_goal', id, old.title, { progress: [old.progress || null, progress] }),
    ]);
    return json({ ok: true });
  }

  if (method === 'DELETE' && seg.length === 3) {
    if (!role.officer) fail(403, 'forbidden');
    await env.DB.batch([env.DB.prepare('DELETE FROM quality_goals WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'quality_goal', id, old.title)]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

/* ------------------------------- PDSA projects ------------------------------- */

const PSELECT = `SELECT p.*, d.name_ar AS dept_ar, d.name_en AS dept_en, u.name AS leader_name, u.name_en AS leader_name_en,
       k.code AS kpi_code, k.name_ar AS kpi_ar, k.name_en AS kpi_en,
       (SELECT COUNT(*) FROM pdsa_cycles c WHERE c.pdsa_id = p.id) AS n_cycles,
       (SELECT MIN(c.due) FROM pdsa_cycles c WHERE c.pdsa_id = p.id AND c.done_at IS NULL) AS next_due
  FROM pdsa p LEFT JOIN departments d ON d.id = p.department_id LEFT JOIN users u ON u.id = p.leader_id LEFT JOIN kpis k ON k.id = p.kpi_id`;

function pdsaOut(p, today) {
  return {
    id: p.id, code: p.code, title: p.title, problem: p.problem || '', aim: p.aim || '', department_id: p.department_id, dept_ar: p.dept_ar || '', dept_en: p.dept_en || '',
    leader_id: p.leader_id, leader_name: p.leader_name || '', leader_name_en: p.leader_name_en || '', team: teamOf(p),
    kpi_id: p.kpi_id, kpi_code: p.kpi_code || '', kpi_ar: p.kpi_ar || '', kpi_en: p.kpi_en || '', baseline: p.baseline, target: p.target,
    start_on: p.start_on, due_on: p.due_on, status: p.status, source: p.source, source_ref: p.source_ref, result: p.result || '',
    n_cycles: p.n_cycles || 0, next_due: p.status === 'active' ? p.next_due : null, late: p.status === 'active' && !!p.next_due && p.next_due < today,
    created_by: p.created_by || '', created_at: p.created_at, closed_at: p.closed_at,
  };
}

export async function nextPdsaCode(env) {
  const r = await env.DB.prepare("SELECT MAX(CAST(substr(code, 6) AS INTEGER)) AS m FROM pdsa WHERE code LIKE 'PDSA-%'").first();
  return 'PDSA-' + String((r.m || 0) + 1).padStart(3, '0');
}

// What could use a project: an indicator below target PDSA_BELOW_RUN periods running, an open high or critical risk,
// or one type of incident reported often - each with no active project on it yet.
async function suggestions(env, today) {
  const [{ results: kpis }, { results: vals }, { results: active }, { results: risks }, { results: ovr }] = await Promise.all([
    env.DB.prepare('SELECT id, code, name_ar, name_en, unit, direction, target FROM kpis WHERE active = 1 AND target IS NOT NULL').all(),
    env.DB.prepare('SELECT kpi_id, period, num, den FROM kpi_values ORDER BY period DESC').all(),
    env.DB.prepare("SELECT kpi_id, source, source_ref FROM pdsa WHERE status = 'active'").all(),
    env.DB.prepare("SELECT id, code, title, likelihood * impact AS score, chapter FROM risks WHERE status = 'open' AND likelihood * impact >= 10 ORDER BY score DESC, id LIMIT 20").all(),
    env.DB.prepare(
      `SELECT c.id, c.name_ar, c.name_en, COUNT(*) AS n FROM ovr o JOIN ovr_categories c ON c.id = o.category_id
        WHERE substr(o.occurred_at, 1, 10) >= ? GROUP BY c.id HAVING n >= ? ORDER BY n DESC LIMIT 20`,
    ).bind(plusDays(today, -SUGGEST_DAYS), SUGGEST_MIN).all(),
  ]);
  const busyKpi = new Set(active.map((a) => a.kpi_id).filter(Boolean));
  const busy = new Set(active.map((a) => a.source + ':' + a.source_ref));
  const by = {};
  for (const v of vals) (by[v.kpi_id] = by[v.kpi_id] || []).push(v);
  const out = [];
  for (const k of kpis) {
    if (busyKpi.has(k.id)) continue;
    const last = (by[k.id] || []).slice(0, PDSA_BELOW_RUN);
    if (last.length === PDSA_BELOW_RUN && last.every((v) => kpiMet(k, kpiValue(k, v.num, v.den)) === false)) {
      out.push({ source: 'kpi', ref: k.id, kpi_id: k.id, title_ar: k.name_ar, title_en: k.name_en, code: k.code, baseline: kpiValue(k, last[0].num, last[0].den), target: k.target });
    }
  }
  for (const r of risks) if (!busy.has('risk:' + r.id)) out.push({ source: 'risk', ref: r.id, title_ar: r.title, title_en: r.title, code: r.code, score: r.score });
  for (const c of ovr) if (!busy.has('ovr:' + c.id)) out.push({ source: 'ovr', ref: c.id, title_ar: c.name_ar, title_en: c.name_en, n: c.n });
  return out.slice(0, 12);
}

export async function handlePdsa(request, env, url, seg, method, user, ctx) {
  const role = riskRole(user);
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
  const inTeam = (p) => p.leader_id === user.id || teamOf(p).includes(user.id);
  const canEdit = (p) => role.officer || (role.dept && p.department_id === role.dept) || inTeam(p);
  const canSee = (p) => role.viewer || canEdit(p);

  if (method === 'GET' && seg.length === 1) {
    const where = role.viewer ? '' : `WHERE p.leader_id = ?1 OR p.team LIKE '%,' || CAST(?1 AS INTEGER) || ',%'${role.dept ? ' OR p.department_id = ?2' : ''}`;
    const stmt = env.DB.prepare(`${PSELECT} ${where} ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END, p.id DESC LIMIT 1000`);
    const [{ results }, { results: departments }, kpis] = await Promise.all([
      role.viewer ? stmt.all() : role.dept ? stmt.bind(user.id, role.dept).all() : stmt.bind(user.id).all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
      kpisLatest(env),
    ]);
    return json({
      projects: results.map((p) => pdsaOut(p, today)),
      departments, today,
      kpis: kpis.filter((k) => k.active),
      suggestions: role.officer ? await suggestions(env, today) : [],
      can_add: role.officer || !!role.dept,
      role: { manager: role.manager, officer: role.officer, viewer: role.viewer, dept: role.dept },
    });
  }

  if (method === 'GET' && seg[1] === 'people' && seg.length === 2) {
    if (!role.officer && !role.dept) fail(403, 'forbidden');
    return json({ people: await people(env) });
  }

  const readHead = async (old) => {
    const b = await readJson(request);
    const keep = (k, f) => (b[k] === undefined && old ? old[k] : f(b[k]));
    const n = {
      title: keep('title', (v) => str(v, 200)),
      problem: keep('problem', (v) => str(v, 3000) || null),
      aim: keep('aim', (v) => str(v, 1000) || null),
      department_id: keep('department_id', toId),
      leader_id: keep('leader_id', toId),
      team: b.team === undefined && old ? old.team : ',' + [...new Set((Array.isArray(b.team) ? b.team : []).map(toId).filter(Boolean))].slice(0, 20).join(',') + ',',
      kpi_id: keep('kpi_id', toId),
      baseline: keep('baseline', numOrNull),
      target: keep('target', numOrNull),
      start_on: keep('start_on', (v) => optDate(v) || null),
      due_on: keep('due_on', (v) => optDate(v) || null),
      source: old ? old.source : ['kpi', 'risk', 'ovr'].includes(b.source) ? b.source : 'manual',
      source_ref: old ? old.source_ref : toId(b.source_ref),
    };
    if (!n.title) fail(400, 'name_required');
    if (!role.officer && role.dept) n.department_id = role.dept;
    if (n.department_id && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(n.department_id).first())) fail(400, 'invalid_department');
    if (n.leader_id && !(await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(n.leader_id).first())) fail(400, 'invalid_user');
    if (n.kpi_id && !(await env.DB.prepare('SELECT id FROM kpis WHERE id = ?').bind(n.kpi_id).first())) fail(400, 'not_found');
    if (n.start_on && n.due_on && n.due_on < n.start_on) fail(400, 'pdsa_bad_dates');
    return n;
  };

  if (method === 'POST' && seg.length === 1) {
    if (!role.officer && !role.dept) fail(403, 'forbidden');
    const n = await readHead(null);
    if (!n.leader_id) n.leader_id = user.id;
    if (!n.start_on) n.start_on = today;
    const now = nowIso();
    const code = await nextPdsaCode(env);
    const res = await env.DB.prepare(
      `INSERT INTO pdsa (code, title, problem, aim, department_id, leader_id, team, kpi_id, baseline, target, start_on, due_on, status, source, source_ref, created_by_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(code, n.title, n.problem, n.aim, n.department_id, n.leader_id, n.team, n.kpi_id, n.baseline, n.target, n.start_on, n.due_on, n.source, n.source_ref, user.id, user.name, now, now).run();
    const id = res.meta.last_row_id;
    await logStmt(env, user, 'create', 'pdsa', id, code + ' ' + n.title).run();
    later(notify(env, settings, [n.leader_id, ...teamOf(n)].filter((x) => x !== user.id), 'team', { id, code, title: n.title, path: '/#/quality/pdsa/' + id }));
    return json({ ok: true, id, code });
  }

  const id = toId(seg[1]);
  const old = id ? await env.DB.prepare(`${PSELECT} WHERE p.id = ?`).bind(id).first() : null;
  if (!old || !canSee(old)) fail(404, 'not_found');
  const active = old.status === 'active';

  if (method === 'GET' && seg.length === 2) {
    const [{ results: cycles }, kpi, { results: values }] = await Promise.all([
      env.DB.prepare('SELECT * FROM pdsa_cycles WHERE pdsa_id = ? ORDER BY n').bind(id).all(),
      old.kpi_id ? env.DB.prepare('SELECT id, code, name_ar, name_en, unit, direction, target, frequency FROM kpis WHERE id = ?').bind(old.kpi_id).first() : null,
      old.kpi_id ? env.DB.prepare('SELECT period, num, den FROM kpi_values WHERE kpi_id = ? ORDER BY period DESC LIMIT 24').bind(old.kpi_id).all() : { results: [] },
    ]);
    const out = pdsaOut(old, today);
    out.cycles = cycles.map((c) => ({ id: c.id, n: c.n, plan: c.plan || '', do_text: c.do_text || '', study: c.study || '', act: c.act || '', due: c.due, done_at: c.done_at, done_by: c.done_by || '', late: !c.done_at && !!c.due && c.due < today && active }));
    if (kpi) {
      const goal = { ...kpi, target: old.target ?? kpi.target };
      out.kpi = { ...kpi, values: values.reverse().map((v) => { const value = kpiValue(kpi, v.num, v.den); return { period: v.period, value, met: kpiMet(goal, value) }; }) };
    }
    const edit = canEdit(old);
    out.can = { edit: edit && active, cycle: edit && active, close: (role.officer || (role.dept && old.department_id === role.dept) || old.leader_id === user.id), delete: role.manager };
    out.people = edit ? await people(env) : [];
    return json({ project: out });
  }

  if (method === 'PUT' && seg.length === 2) {
    if (!canEdit(old)) fail(403, 'forbidden');
    if (!active) fail(409, 'pdsa_closed');
    const n = await readHead(old);
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE pdsa SET title = ?, problem = ?, aim = ?, department_id = ?, leader_id = ?, team = ?, kpi_id = ?, baseline = ?, target = ?, start_on = ?, due_on = ?, updated_at = ? WHERE id = ?',
      ).bind(n.title, n.problem, n.aim, n.department_id, n.leader_id, n.team, n.kpi_id, n.baseline, n.target, n.start_on, n.due_on, nowIso(), id),
      logStmt(env, user, 'update', 'pdsa', id, old.code),
    ]);
    const added = [...(n.leader_id !== old.leader_id ? [n.leader_id] : []), ...teamOf(n).filter((x) => !teamOf(old).includes(x))].filter((x) => x && x !== user.id);
    if (added.length) later(notify(env, settings, added, 'team', { id, code: old.code, title: n.title, path: '/#/quality/pdsa/' + id }));
    return json({ ok: true });
  }

  // POST /pdsa/<id>/cycles {plan, due}: the next cycle, once the one before is done.
  if (method === 'POST' && seg[2] === 'cycles' && seg.length === 3) {
    if (!canEdit(old)) fail(403, 'forbidden');
    if (!active) fail(409, 'pdsa_closed');
    const b = await readJson(request);
    const plan = str(b.plan, 3000);
    if (!plan) fail(400, 'pdsa_plan_required');
    const last = await env.DB.prepare('SELECT n, done_at FROM pdsa_cycles WHERE pdsa_id = ? ORDER BY n DESC LIMIT 1').bind(id).first();
    if (last && !last.done_at) fail(409, 'pdsa_cycle_open');
    if (last && last.n >= MAX_CYCLES) fail(400, 'pdsa_too_many');
    const due = optDate(b.due) || plusDays(today, 30);
    const n = last ? last.n + 1 : 1;
    const now = nowIso();
    const res = await env.DB.prepare('INSERT INTO pdsa_cycles (pdsa_id, n, plan, due, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, n, plan, due, now, now).run();
    await env.DB.batch([env.DB.prepare('UPDATE pdsa SET updated_at = ? WHERE id = ?').bind(now, id), logStmt(env, user, 'cycle', 'pdsa', id, old.code, { cycle: [null, n] })]);
    return json({ ok: true, id: res.meta.last_row_id, n });
  }

  // PUT /pdsa/<id>/cycles/<cid> {plan, do_text, study, act, due, done}: fill the cycle in; done needs Study and Act.
  if (method === 'PUT' && seg[2] === 'cycles' && seg.length === 4) {
    if (!canEdit(old)) fail(403, 'forbidden');
    if (!active) fail(409, 'pdsa_closed');
    const c = await env.DB.prepare('SELECT * FROM pdsa_cycles WHERE id = ? AND pdsa_id = ?').bind(toId(seg[3]), id).first();
    if (!c) fail(404, 'not_found');
    const b = await readJson(request);
    const keep = (k, f) => (b[k] === undefined ? c[k] : f(b[k]));
    const n = {
      plan: keep('plan', (v) => str(v, 3000)),
      do_text: keep('do_text', (v) => str(v, 3000) || null),
      study: keep('study', (v) => str(v, 3000) || null),
      act: keep('act', (v) => (PDSA_ACTS.includes(v) ? v : null)),
      due: keep('due', (v) => optDate(v) || c.due),
    };
    if (!n.plan) fail(400, 'pdsa_plan_required');
    const done = b.done === undefined ? !!c.done_at : !!b.done;
    if (done && (!n.study || !n.act)) fail(400, 'pdsa_study_required');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE pdsa_cycles SET plan = ?, do_text = ?, study = ?, act = ?, due = ?, done_at = ?, done_by = ?, updated_at = ? WHERE id = ?')
        .bind(n.plan, n.do_text, n.study, n.act, n.due, done ? c.done_at || now : null, done ? c.done_by || user.name : null, now, c.id),
      env.DB.prepare('UPDATE pdsa SET updated_at = ? WHERE id = ?').bind(now, id),
      logStmt(env, user, 'update', 'pdsa_cycle', id, old.code + ' #' + c.n, done && !c.done_at ? { done: [null, n.act] } : null),
    ]);
    return json({ ok: true });
  }

  // POST /pdsa/<id>/close {status: done | stopped | active, result}: finished (with the result), stopped, or open again.
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    const can = role.officer || (role.dept && old.department_id === role.dept) || old.leader_id === user.id;
    if (!can) fail(403, 'forbidden');
    const b = await readJson(request);
    const status = PDSA_STATUS.includes(b.status) ? b.status : 'done';
    if (status === 'active' && !role.manager) fail(403, 'forbidden');
    const result = str(b.result, 3000) || null;
    if (status === 'done' && (!result || result.length < 3)) fail(400, 'pdsa_result_required');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE pdsa SET status = ?, result = ?, closed_at = ?, updated_at = ? WHERE id = ?').bind(status, status === 'active' ? old.result : result, status === 'active' ? null : now, now, id),
      logStmt(env, user, status === 'active' ? 'reopen' : 'close', 'pdsa', id, old.code, { status: [old.status, status] }),
    ]);
    return json({ ok: true });
  }

  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pdsa_cycles WHERE pdsa_id = ?').bind(id),
      env.DB.prepare('UPDATE quality_goals SET pdsa_id = NULL WHERE pdsa_id = ?').bind(id),
      env.DB.prepare('DELETE FROM pdsa WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'pdsa', id, old.code + ' ' + old.title),
    ]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

/* ----------------------------------- reminders ----------------------------------- */

// Daily: a cycle whose date has come reminds the leader, then once a week while late (with the quality managers).
export async function runPdsaReminders(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.n, c.due, p.id AS pid, p.code, p.title, p.leader_id FROM pdsa_cycles c JOIN pdsa p ON p.id = c.pdsa_id
      WHERE p.status = 'active' AND c.done_at IS NULL AND c.due <= ? AND (c.reminded_on IS NULL OR c.reminded_on <= ?) ORDER BY c.due LIMIT 30`,
  ).bind(today, plusDays(today, -7)).all();
  const mgrs = results.some((r) => r.due < today) ? await managerIds(env) : [];
  for (const r of results) await notify(env, settings, [r.leader_id, ...(r.due < today ? mgrs : [])], 'cycle', { id: r.pid, code: r.code, title: r.title, cycle: r.n, due: r.due, path: '/#/quality/pdsa/' + r.pid });
  if (results.length) await env.DB.prepare(`UPDATE pdsa_cycles SET reminded_on = ? WHERE id IN (${results.map((r) => r.id).join(',')})`).bind(today).run();
  return { cycles: results.length };
}

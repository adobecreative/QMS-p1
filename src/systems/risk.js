// Risk register and FMEA. A risk: what could go wrong, where, how likely (1-5) and how bad (1-5), the owner,
// the controls, the actions (each one a CAPA), and a review date set by the level (critical monthly ... low yearly).
// Department heads add and review their own department's risks; quality runs the whole register.
// FMEA: a process in steps, each step's failure modes scored severity x occurrence x detection (1-10 each = RPN),
// with an action per mode; approval opens the actions as CAPA, and the scores after the action are kept beside.
import { readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { sendPush } from '../lib/push.js';
import { escHtml, fail, json, nowIso, optDate, str, todayIn } from '../lib/util.js';
import { plusDays } from './docs.js';

export const RISK_CATS = ['clinical', 'patient_safety', 'medication', 'infection', 'facility', 'equipment', 'staff', 'it', 'financial', 'legal', 'reputation'];
export const RISK_RESPONSES = ['mitigate', 'accept', 'transfer', 'avoid'];
// Level from the score (likelihood x impact) and the days until the next review.
export const riskLevel = (score) => (score >= 15 ? 'critical' : score >= 10 ? 'high' : score >= 5 ? 'medium' : 'low');
export const REVIEW_DAYS = { critical: 30, high: 90, medium: 180, low: 365 };
// Reports of one type in this many days suggest a risk.
export const SUGGEST_DAYS = 90;
export const SUGGEST_MIN = 3;
// An RPN at or above this, or a severity of 9-10, is high.
export const RPN_HIGH = 100;
const MAX_STEPS = 30;
const MAX_MODES = 15;

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const scale = (v, max) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max ? Number(v) : null);
const teamOf = (f) => String((f && f.team) || '').split(',').map(Number).filter((x) => x > 0);

export function riskRole(u) {
  const q = u.quality || 'none';
  const manager = q === 'admin' || q === 'manager';
  const officer = manager || q === 'assessor';
  const viewer = officer || q === 'viewer';
  // A department head (the committees role "department head / secretary") runs their own department's risks.
  const deptHead = !officer && (u.meetings === 'secretary' || u.meetings_role === 'secretary') && u.department_id ? u.department_id : null;
  return { manager, officer, viewer, dept: deptHead };
}

export async function riskAccess(env, u) {
  const r = riskRole(u);
  if (r.manager) return 'manager';
  if (r.officer) return 'officer';
  if (r.viewer) return 'viewer';
  if (r.dept) return 'dept';
  const x = await env.DB.prepare("SELECT 1 AS x FROM risks WHERE owner_id = ?1 AND status = 'open' UNION SELECT 1 FROM fmea WHERE team LIKE '%,' || CAST(?1 AS INTEGER) || ',%' LIMIT 1").bind(u.id).first();
  return x ? 'member' : 'none';
}

/* ------------------------------ notifications ------------------------------ */

const MAIL = {
  ar: {
    dir: 'rtl',
    kind: { owner: 'أصبحت مالك خطر', review: 'تذكير: مراجعة خطر', critical: 'خطر حرج جديد', fmea_team: 'أُضفت إلى فريق FMEA' },
    labels: { level: 'المستوى', due: 'موعد المراجعة', dept: 'القسم' },
    level: { critical: 'حرج', high: 'عالٍ', medium: 'متوسط', low: 'منخفض' },
    open: 'فتح',
    footer: (app) => `رسالة تلقائية من ${app}.`,
  },
  en: {
    dir: 'ltr',
    kind: { owner: 'You own a risk', review: 'Reminder: risk review', critical: 'New critical risk', fmea_team: 'You were added to an FMEA team' },
    labels: { level: 'Level', due: 'Review by', dept: 'Department' },
    level: { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' },
    open: 'Open',
    footer: (app) => `Automatic message from ${app}.`,
  },
};

async function notifyRisk(env, settings, userIds, kind, x) {
  const ids = [...new Set(userIds.filter((v) => Number.isInteger(v) && v > 0))];
  if (!ids.length) return;
  const { results: people } = await env.DB.prepare(`SELECT id, email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const fmea = kind === 'fmea_team';
  const path = fmea ? '/#/risk/fmea/' + x.id : '/#/risk/risks/' + x.id;
  const ref = fmea ? 'FMEA #' + x.id : x.code;
  const jobs = [];
  if (people.length && mailReady(settings)) {
    const mail = bothLangs(settings, (s) => {
      const L = MAIL[s.email_lang === 'en' ? 'en' : 'ar'];
      const app = appName(s, s.email_lang);
      const align = L.dir === 'rtl' ? 'right' : 'left';
      const row = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#6e6553;text-align:${align}">${escHtml(L.labels[k])}</td><td style="padding:4px 10px;text-align:${align}">${escHtml(v)}</td></tr>` : '');
      const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
        <p style="font-size:16px;font-weight:bold">${escHtml(L.kind[kind])} <span dir="ltr">${escHtml(ref)}</span></p>
        <p>${escHtml(x.title)}</p>
        <table style="border-collapse:collapse">${fmea ? '' : row('level', L.level[riskLevel(x.likelihood * x.impact)]) + row('due', x.next_review)}</table>
        <p style="margin:20px 0"><a href="${escHtml((s.site_url || '') + path)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
      return { subject: `${L.kind[kind]} ${ref} - ${app}`, html };
    });
    jobs.push(sendMail(settings, people.map((p) => ({ to: p.email, ...mail }))));
  }
  jobs.push(
    sendPush(env, ids, (lang) => {
      const L = MAIL[lang === 'en' ? 'en' : 'ar'];
      return { title: `${L.kind[kind]} ${ref}`, body: x.title, url: path, tag: (fmea ? 'fmea-' : 'risk-') + x.id };
    }),
  );
  await Promise.all(jobs.map((p) => p.catch((e) => console.error('risk notify', e))));
}

const managerIds = async (env) => (await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role = 'manager'").all()).results.map((r) => r.id);

/* --------------------------------- reading --------------------------------- */

const SELECT = `SELECT r.*, d.name_ar AS dept_ar, d.name_en AS dept_en, u.name AS owner_name, u.name_en AS owner_name_en,
       c.name_ar AS cat_ar, c.name_en AS cat_en,
       (SELECT COUNT(*) FROM capa a WHERE a.risk_id = r.id) AS n_actions,
       (SELECT COUNT(*) FROM capa a WHERE a.risk_id = r.id AND a.status IN ('open', 'doing')) AS open_actions
  FROM risks r LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN users u ON u.id = r.owner_id
  LEFT JOIN ovr_categories c ON c.id = r.ovr_cat_id`;

function riskOut(r, today) {
  const score = r.likelihood * r.impact;
  const rScore = r.res_likelihood && r.res_impact ? r.res_likelihood * r.res_impact : null;
  return {
    id: r.id, code: r.code, title: r.title, description: r.description || '', category: r.category, department_id: r.department_id, dept_ar: r.dept_ar || '', dept_en: r.dept_en || '',
    chapter: r.chapter || '', owner_id: r.owner_id, owner_name: r.owner_name || '', owner_name_en: r.owner_name_en || '',
    likelihood: r.likelihood, impact: r.impact, score, level: riskLevel(score),
    res_likelihood: r.res_likelihood, res_impact: r.res_impact, res_score: rScore, res_level: rScore ? riskLevel(rScore) : null,
    controls: r.controls || '', response: r.response, status: r.status, next_review: r.next_review, last_review: r.last_review,
    review_late: r.status === 'open' && !!r.next_review && r.next_review < today,
    ovr_cat_id: r.ovr_cat_id, ovr_cat_ar: r.cat_ar || '', ovr_cat_en: r.cat_en || '',
    n_actions: r.n_actions || 0, open_actions: r.open_actions || 0, created_by: r.created_by || '', created_at: r.created_at, updated_at: r.updated_at, closed_at: r.closed_at,
  };
}

// The categories of incident reported SUGGEST_MIN times or more in the last SUGGEST_DAYS days with no open risk.
async function suggestions(env, today) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name_ar, c.name_en, c.chapter, COUNT(*) AS n FROM ovr o JOIN ovr_categories c ON c.id = o.category_id
      WHERE substr(o.occurred_at, 1, 10) >= ? AND c.id NOT IN (SELECT ovr_cat_id FROM risks WHERE status = 'open' AND ovr_cat_id IS NOT NULL)
      GROUP BY c.id HAVING n >= ? ORDER BY n DESC LIMIT 10`,
  ).bind(plusDays(today, -SUGGEST_DAYS), SUGGEST_MIN).all();
  return results;
}

async function nextCode(env) {
  const r = await env.DB.prepare("SELECT MAX(CAST(substr(code, 5) AS INTEGER)) AS m FROM risks WHERE code LIKE 'RSK-%'").first();
  return 'RSK-' + String((r.m || 0) + 1).padStart(3, '0');
}

async function people(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.name_en, u.department_id, d.name_ar AS dept_ar, d.name_en AS dept_en FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.active = 1 AND u.id <> (SELECT MIN(id) FROM users) ORDER BY u.name`,
  ).all();
  return results;
}

async function addCapa(env, x) {
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO capa (source, risk_id, fmea_id, title, detail, department_id, chapter, owner, due, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?), ?, ?, 'open', ?, ?, ?)`,
  )
    .bind(x.source, x.risk_id || null, x.fmea_id || null, x.title.slice(0, 500), x.detail || null, x.department_id || null, x.chapter || '', x.owner || null, x.due, x.by || null, now, now)
    .run();
  return res.meta.last_row_id;
}

/* ---------------------------------- routes ---------------------------------- */

export async function handleRisk(request, env, url, seg, method, user, ctx) {
  const role = riskRole(user);
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
  if (seg[1] === 'fmea') return handleFmea(request, env, seg, method, user, role, settings, today, later);

  // Who can see and change a risk.
  const canEdit = (r) => role.officer || (role.dept && r.department_id === role.dept);
  const canSee = (r) => role.viewer || canEdit(r) || r.owner_id === user.id;

  // GET /risk/people: the accounts a risk can be given to.
  if (method === 'GET' && seg[1] === 'people' && seg.length === 2) {
    if (!role.officer && !role.dept) fail(403, 'forbidden');
    return json({ people: await people(env) });
  }

  // GET /risk/report: the register's figures and the 5x5 heat map.
  if (method === 'GET' && seg[1] === 'report' && seg.length === 2) {
    if (!role.viewer) fail(403, 'forbidden');
    const { results } = await env.DB.prepare(`${SELECT} WHERE r.status = 'open'`).all();
    const list = results.map((r) => riskOut(r, today));
    const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
    for (const r of list) grid[r.likelihood - 1][r.impact - 1] += 1;
    return json({ grid, top: list.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 10) });
  }

  if (method === 'GET' && seg.length === 1) {
    const where = role.viewer ? '' : role.dept ? 'WHERE r.department_id = ?1 OR r.owner_id = ?2' : 'WHERE r.owner_id = ?2';
    const stmt = env.DB.prepare(`${SELECT} ${where} ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.likelihood * r.impact DESC, r.id DESC LIMIT 2000`);
    const [{ results }, { results: departments }, { results: chapters }] = await Promise.all([
      role.viewer ? stmt.all() : role.dept ? stmt.bind(role.dept, user.id).all() : stmt.bind(null, user.id).all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
      env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' AND active = 1 ORDER BY sort, code").all(),
    ]);
    return json({
      risks: results.map((r) => riskOut(r, today)),
      departments, chapters, today,
      suggestions: role.officer ? await suggestions(env, today) : [],
      role: { manager: role.manager, officer: role.officer, viewer: role.viewer, dept: role.dept },
    });
  }

  const readRisk = async (old) => {
    const b = await readJson(request);
    const keep = (k, f) => (b[k] === undefined && old ? old[k] : f(b[k]));
    const next = {
      title: keep('title', (v) => str(v, 200)),
      description: keep('description', (v) => str(v, 3000) || null),
      category: keep('category', (v) => str(v, 20)),
      department_id: keep('department_id', toId),
      chapter: keep('chapter', (v) => str(v, 6).toUpperCase() || null),
      owner_id: keep('owner_id', toId),
      likelihood: keep('likelihood', (v) => scale(v, 5)),
      impact: keep('impact', (v) => scale(v, 5)),
      res_likelihood: keep('res_likelihood', (v) => scale(v, 5)),
      res_impact: keep('res_impact', (v) => scale(v, 5)),
      controls: keep('controls', (v) => str(v, 3000) || null),
      response: keep('response', (v) => str(v, 12) || 'mitigate'),
      ovr_cat_id: keep('ovr_cat_id', toId),
    };
    if (!next.title) fail(400, 'name_required');
    if (!RISK_CATS.includes(next.category)) fail(400, 'risk_bad_category');
    if (!RISK_RESPONSES.includes(next.response)) fail(400, 'risk_bad_response');
    if (!next.likelihood || !next.impact) fail(400, 'risk_bad_score');
    if (!next.res_likelihood !== !next.res_impact) fail(400, 'risk_bad_score');
    // A department head keeps the risk in their own department.
    if (!role.officer) next.department_id = role.dept;
    if (next.department_id && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(next.department_id).first())) fail(400, 'invalid_department');
    if (next.owner_id && !(await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(next.owner_id).first())) fail(400, 'invalid_user');
    if (next.chapter && !(await env.DB.prepare("SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?").bind(next.chapter).first())) fail(400, 'std_bad_chapter');
    if (next.ovr_cat_id && !(await env.DB.prepare('SELECT id FROM ovr_categories WHERE id = ?').bind(next.ovr_cat_id).first())) next.ovr_cat_id = null;
    return next;
  };

  if (method === 'POST' && seg.length === 1) {
    if (!role.officer && !role.dept) fail(403, 'forbidden');
    const n = await readRisk(null);
    if (!n.owner_id) n.owner_id = user.id;
    const now = nowIso();
    const code = await nextCode(env);
    const due = plusDays(today, REVIEW_DAYS[riskLevel(n.likelihood * n.impact)]);
    const res = await env.DB.prepare(
      `INSERT INTO risks (code, title, description, category, department_id, chapter, owner_id, likelihood, impact, res_likelihood, res_impact, controls, response, ovr_cat_id,
         status, next_review, last_review, created_by_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(code, n.title, n.description, n.category, n.department_id, n.chapter, n.owner_id, n.likelihood, n.impact, n.res_likelihood, n.res_impact, n.controls, n.response, n.ovr_cat_id, due, today, user.id, user.name, now, now)
      .run();
    const id = res.meta.last_row_id;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO risk_reviews (risk_id, at, by_name, likelihood, impact, note) VALUES (?, ?, ?, ?, ?, ?)').bind(id, now, user.name, n.likelihood, n.impact, null),
      logStmt(env, user, 'create', 'risk', id, code + ' ' + n.title),
    ]);
    const r = { id, code, title: n.title, likelihood: n.likelihood, impact: n.impact, next_review: due };
    if (n.owner_id !== user.id) later(notifyRisk(env, settings, [n.owner_id], 'owner', r));
    if (riskLevel(n.likelihood * n.impact) === 'critical') later(notifyRisk(env, settings, (await managerIds(env)).filter((x) => x !== user.id), 'critical', r));
    return json({ ok: true, id, code });
  }

  const id = toId(seg[1]);
  const old = id ? await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first() : null;
  if (!old || !canSee(old)) fail(404, 'not_found');

  if (method === 'GET' && seg.length === 2) {
    const [{ results: reviews }, { results: actions }] = await Promise.all([
      env.DB.prepare('SELECT at, by_name, likelihood, impact, note FROM risk_reviews WHERE risk_id = ? ORDER BY id DESC LIMIT 50').bind(id).all(),
      env.DB.prepare('SELECT id, title, owner, due, status, done_at FROM capa WHERE risk_id = ? ORDER BY id').bind(id).all(),
    ]);
    const out = riskOut(old, today);
    out.reviews = reviews;
    out.actions = actions.map((a) => ({ ...a, late: ['open', 'doing'].includes(a.status) && a.due && a.due < today }));
    out.can = { edit: canEdit(old) && old.status === 'open', review: (canEdit(old) || old.owner_id === user.id) && old.status === 'open', close: canEdit(old), delete: role.manager };
    return json({ risk: out });
  }

  if (method === 'PUT' && seg.length === 2) {
    if (!canEdit(old)) fail(403, 'forbidden');
    if (old.status !== 'open') fail(409, 'risk_closed');
    const n = await readRisk(old);
    const now = nowIso();
    const rated = n.likelihood !== old.likelihood || n.impact !== old.impact;
    const due = rated ? plusDays(today, REVIEW_DAYS[riskLevel(n.likelihood * n.impact)]) : old.next_review;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE risks SET title = ?, description = ?, category = ?, department_id = ?, chapter = ?, owner_id = ?, likelihood = ?, impact = ?, res_likelihood = ?, res_impact = ?,
           controls = ?, response = ?, ovr_cat_id = ?, next_review = ?, last_review = ?, updated_at = ? WHERE id = ?`,
      ).bind(n.title, n.description, n.category, n.department_id, n.chapter, n.owner_id, n.likelihood, n.impact, n.res_likelihood, n.res_impact, n.controls, n.response, n.ovr_cat_id, due, rated ? today : old.last_review, now, id),
      ...(rated ? [env.DB.prepare('INSERT INTO risk_reviews (risk_id, at, by_name, likelihood, impact, note) VALUES (?, ?, ?, ?, ?, ?)').bind(id, now, user.name, n.likelihood, n.impact, null)] : []),
      logStmt(env, user, 'update', 'risk', id, old.code, changes(old, n, ['title', 'category', 'department_id', 'owner_id', 'likelihood', 'impact', 'res_likelihood', 'res_impact', 'response'])),
    ]);
    if (n.owner_id && n.owner_id !== old.owner_id && n.owner_id !== user.id) later(notifyRisk(env, settings, [n.owner_id], 'owner', { ...old, ...n, next_review: due }));
    return json({ ok: true });
  }

  // POST /risk/<id>/review {likelihood, impact, note}: the owner or the department head rates it again.
  if (method === 'POST' && seg[2] === 'review' && seg.length === 3) {
    if (!canEdit(old) && old.owner_id !== user.id) fail(403, 'forbidden');
    if (old.status !== 'open') fail(409, 'risk_closed');
    const b = await readJson(request);
    const l = scale(b.likelihood, 5);
    const i = scale(b.impact, 5);
    if (!l || !i) fail(400, 'risk_bad_score');
    const note = str(b.note, 2000) || null;
    const due = plusDays(today, REVIEW_DAYS[riskLevel(l * i)]);
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE risks SET likelihood = ?, impact = ?, last_review = ?, next_review = ?, reminded_on = NULL, updated_at = ? WHERE id = ?').bind(l, i, today, due, now, id),
      env.DB.prepare('INSERT INTO risk_reviews (risk_id, at, by_name, likelihood, impact, note) VALUES (?, ?, ?, ?, ?, ?)').bind(id, now, user.name, l, i, note),
      logStmt(env, user, 'review', 'risk', id, old.code, { score: [old.likelihood * old.impact, l * i] }),
    ]);
    return json({ ok: true, next_review: due });
  }

  // POST /risk/<id>/actions {title, owner, due}: an action to lower the risk, kept as a CAPA.
  if (method === 'POST' && seg[2] === 'actions' && seg.length === 3) {
    if (!canEdit(old)) fail(403, 'forbidden');
    if (old.status !== 'open') fail(409, 'risk_closed');
    const b = await readJson(request);
    const title = str(b.title, 500);
    if (!title) fail(400, 'name_required');
    const due = optDate(b.due) || plusDays(today, 30);
    const capaId = await addCapa(env, { source: 'risk', risk_id: id, title, detail: old.code + ' ' + old.title, department_id: old.department_id, chapter: old.chapter, owner: str(b.owner, 150) || null, due, by: user.name });
    await env.DB.batch([env.DB.prepare('UPDATE risks SET updated_at = ? WHERE id = ?').bind(nowIso(), id), logStmt(env, user, 'action', 'risk', id, old.code, { capa: [null, capaId] })]);
    return json({ ok: true, capa_id: capaId });
  }

  // POST /risk/<id>/close {closed: true|false}: no longer a risk (or open again).
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    if (!canEdit(old)) fail(403, 'forbidden');
    const b = await readJson(request);
    const close = b.closed !== false;
    await env.DB.batch([
      env.DB.prepare('UPDATE risks SET status = ?, closed_at = ?, next_review = ?, updated_at = ? WHERE id = ?')
        .bind(close ? 'closed' : 'open', close ? nowIso() : null, close ? old.next_review : plusDays(today, REVIEW_DAYS[riskLevel(old.likelihood * old.impact)]), nowIso(), id),
      logStmt(env, user, close ? 'close' : 'reopen', 'risk', id, old.code),
    ]);
    return json({ ok: true });
  }

  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM risk_reviews WHERE risk_id = ?').bind(id),
      env.DB.prepare('DELETE FROM capa WHERE risk_id = ?').bind(id),
      env.DB.prepare('DELETE FROM risks WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'risk', id, old.code + ' ' + old.title),
    ]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

/* ----------------------------------- FMEA ----------------------------------- */

const FSELECT = `SELECT f.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM fmea f LEFT JOIN departments d ON d.id = f.department_id`;
const parse = (v) => {
  try {
    return JSON.parse(v || '[]');
  } catch {
    return [];
  }
};
const rpn = (m) => (m.s && m.o && m.d ? m.s * m.o * m.d : null);
const rpn2 = (m) => (m.s2 && m.o2 && m.d2 ? m.s2 * m.o2 * m.d2 : null);

function fmeaOut(f, full) {
  const steps = parse(f.steps);
  const modes = steps.flatMap((s) => s.modes || []);
  const out = {
    id: f.id, title: f.title, process: f.process || '', department_id: f.department_id, dept_ar: f.dept_ar || '', dept_en: f.dept_en || '', status: f.status, team: teamOf(f),
    n_modes: modes.length, n_high: modes.filter((m) => (rpn(m) || 0) >= RPN_HIGH || (m.s || 0) >= 9).length, max_rpn: Math.max(0, ...modes.map((m) => rpn(m) || 0)),
    max_rpn2: modes.some(rpn2) ? Math.max(0, ...modes.map((m) => rpn2(m) || rpn(m) || 0)) : null,
    created_by: f.created_by || '', created_at: f.created_at, updated_at: f.updated_at, approved_at: f.approved_at, approved_by: f.approved_by || '',
  };
  if (full) out.steps = steps;
  return out;
}

// The steps from the editor, cleaned. After approval only the scores after the action change.
function readSteps(raw, old, approved) {
  if (!Array.isArray(raw)) fail(400, 'fmea_bad_steps');
  const s10 = (v) => scale(v, 10);
  if (approved) {
    return old.map((st, i) => ({
      ...st,
      modes: (st.modes || []).map((m, j) => {
        const n = ((raw[i] || {}).modes || [])[j] || {};
        return { ...m, s2: s10(n.s2), o2: s10(n.o2), d2: s10(n.d2) };
      }),
    }));
  }
  if (raw.length > MAX_STEPS) fail(400, 'fmea_too_many');
  return raw.map((st) => {
    const modes = Array.isArray(st.modes) ? st.modes : [];
    if (modes.length > MAX_MODES) fail(400, 'fmea_too_many');
    return {
      step: str(st.step, 300),
      modes: modes.map((m) => ({
        mode: str(m.mode, 500), effect: str(m.effect, 500), cause: str(m.cause, 500), controls: str(m.controls, 500),
        s: s10(m.s), o: s10(m.o), d: s10(m.d), action: str(m.action, 500), owner_id: toId(m.owner_id), due: m.due ? optDate(m.due) : null,
        s2: s10(m.s2), o2: s10(m.o2), d2: s10(m.d2),
      })),
    };
  });
}

async function handleFmea(request, env, seg, method, user, role, settings, today, later) {
  const inTeam = (f) => teamOf(f).includes(user.id);
  const canEdit = (f) => role.officer || inTeam(f) || f.created_by_id === user.id;

  if (method === 'GET' && seg.length === 2) {
    const { results } = role.viewer
      ? await env.DB.prepare(`${FSELECT} ORDER BY f.id DESC LIMIT 500`).all()
      : await env.DB.prepare(`${FSELECT} WHERE f.team LIKE '%,' || CAST(?1 AS INTEGER) || ',%' OR f.created_by_id = ?1 ${role.dept ? 'OR f.department_id = ?2' : ''} ORDER BY f.id DESC LIMIT 500`).bind(user.id, role.dept || 0).all();
    const { results: departments } = await env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all();
    return json({ fmea: results.map((f) => fmeaOut(f, false)), departments, can_add: role.officer || !!role.dept, rpn_high: RPN_HIGH });
  }

  const readHead = async (b, old) => {
    const next = {
      title: b.title === undefined && old ? old.title : str(b.title, 200),
      process: b.process === undefined && old ? old.process : str(b.process, 2000) || null,
      department_id: b.department_id === undefined && old ? old.department_id : toId(b.department_id),
      team: b.team === undefined && old ? old.team : ',' + [...new Set((Array.isArray(b.team) ? b.team : []).map(toId).filter(Boolean))].slice(0, 20).join(',') + ',',
    };
    if (!next.title) fail(400, 'name_required');
    if (!role.officer && role.dept) next.department_id = role.dept;
    return next;
  };

  if (method === 'POST' && seg.length === 2) {
    if (!role.officer && !role.dept) fail(403, 'forbidden');
    const b = await readJson(request);
    const n = await readHead(b, null);
    const now = nowIso();
    const res = await env.DB.prepare("INSERT INTO fmea (title, process, department_id, team, steps, status, created_by_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'draft', ?, ?, ?, ?)")
      .bind(n.title, n.process, n.department_id, n.team, user.id, user.name, now, now)
      .run();
    const id = res.meta.last_row_id;
    await logStmt(env, user, 'create', 'fmea', id, n.title).run();
    later(notifyRisk(env, settings, teamOf(n).filter((x) => x !== user.id), 'fmea_team', { id, title: n.title }));
    return json({ ok: true, id });
  }

  const id = toId(seg[2]);
  const old = id ? await env.DB.prepare(`${FSELECT} WHERE f.id = ?`).bind(id).first() : null;
  if (!old || !(role.viewer || canEdit(old) || (role.dept && old.department_id === role.dept))) fail(404, 'not_found');
  const approved = old.status === 'approved';

  if (method === 'GET' && seg.length === 3) {
    const out = fmeaOut(old, true);
    const { results } = await env.DB.prepare('SELECT id, title, owner, due, status FROM capa WHERE fmea_id = ? ORDER BY id').bind(id).all();
    out.actions = results;
    out.can = { edit: canEdit(old), approve: role.manager && !approved, delete: role.manager };
    out.rpn_high = RPN_HIGH;
    out.people = canEdit(old) ? await people(env) : [];
    return json({ fmea: out });
  }

  if (method === 'PUT' && seg.length === 3) {
    if (!canEdit(old)) fail(403, 'forbidden');
    const b = await readJson(request);
    const head = approved ? old : await readHead(b, old);
    const steps = b.steps === undefined ? parse(old.steps) : readSteps(b.steps, parse(old.steps), approved);
    await env.DB.batch([
      env.DB.prepare('UPDATE fmea SET title = ?, process = ?, department_id = ?, team = ?, steps = ?, updated_at = ? WHERE id = ?').bind(head.title, head.process, head.department_id, head.team, JSON.stringify(steps), nowIso(), id),
      logStmt(env, user, 'update', 'fmea', id, head.title),
    ]);
    const added = teamOf(head).filter((x) => !teamOf(old).includes(x) && x !== user.id);
    if (added.length) later(notifyRisk(env, settings, added, 'fmea_team', { id, title: head.title }));
    return json({ ok: true });
  }

  // POST /risk/fmea/<id>/approve: the quality manager approves; each mode with an action opens a CAPA.
  if (method === 'POST' && seg[3] === 'approve' && seg.length === 4) {
    if (!role.manager) fail(403, 'forbidden');
    if (approved) fail(409, 'fmea_approved');
    const steps = parse(old.steps);
    const modes = steps.flatMap((s) => s.modes || []);
    if (!modes.length) fail(400, 'fmea_empty');
    if (modes.some((m) => !rpn(m))) fail(400, 'fmea_unscored');
    const todo = modes.filter((m) => m.action);
    if (todo.some((m) => !m.owner_id || !m.due)) fail(400, 'fmea_action_owner');
    const owners = Object.fromEntries((await people(env)).map((p) => [p.id, p.name]));
    for (const m of todo) m.capa_id = await addCapa(env, { source: 'fmea', fmea_id: id, title: m.action, detail: 'FMEA #' + id + ' ' + old.title + ': ' + m.mode, department_id: old.department_id, owner: owners[m.owner_id] || null, due: m.due, by: user.name });
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE fmea SET status = 'approved', steps = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(steps), now, user.name, now, id),
      logStmt(env, user, 'approve', 'fmea', id, old.title, { capa: [null, todo.length] }),
    ]);
    return json({ ok: true, actions: todo.length });
  }

  if (method === 'DELETE' && seg.length === 3) {
    if (!role.manager) fail(403, 'forbidden');
    await env.DB.batch([env.DB.prepare('DELETE FROM capa WHERE fmea_id = ?').bind(id), env.DB.prepare('DELETE FROM fmea WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'fmea', id, old.title)]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

/* ------------------------------ home and reminders ----------------------------- */

export async function riskHome(env, user, today) {
  const role = riskRole(user);
  if (role.viewer || role.dept) {
    const where = role.viewer ? '' : ' AND department_id = ' + Number(role.dept);
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS open, COALESCE(SUM(likelihood * impact >= 15), 0) AS critical, COALESCE(SUM(likelihood * impact >= 10 AND likelihood * impact < 15), 0) AS high,
              COALESCE(SUM(next_review < ?), 0) AS late FROM risks WHERE status = 'open'${where}`,
    ).bind(today).first();
    return { open: r.open, critical: r.critical, high: r.high, late: r.late };
  }
  const r = await env.DB.prepare("SELECT COUNT(*) AS mine, COALESCE(SUM(next_review <= ?), 0) AS due FROM risks WHERE status = 'open' AND owner_id = ?").bind(today, user.id).first();
  return r.mine ? { mine: r.mine, due: r.due } : null;
}

// Daily: a risk whose review date has come reminds its owner, then once a week while late (and the quality managers too).
export async function runRiskReminders(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results } = await env.DB.prepare(
    "SELECT * FROM risks WHERE status = 'open' AND next_review <= ? AND (reminded_on IS NULL OR reminded_on <= ?) ORDER BY next_review LIMIT 30",
  ).bind(today, plusDays(today, -7)).all();
  const mgrs = results.some((r) => r.next_review < today) ? await managerIds(env) : [];
  for (const r of results) await notifyRisk(env, settings, [r.owner_id, ...(r.next_review < today ? mgrs : [])], 'review', r);
  if (results.length) await env.DB.prepare(`UPDATE risks SET reminded_on = ? WHERE id IN (${results.map((r) => r.id).join(',')})`).bind(today).run();
  return { reviews: results.length };
}

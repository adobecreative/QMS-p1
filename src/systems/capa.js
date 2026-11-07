// Corrective and preventive actions (CAPA): what failed, who fixes it by when, the cause, what was done, and
// quality's check that it worked. A failed line of a quality round opens one on its own; others are added by hand.
// Each one can name its chapter and standard, so it shows as work on that standard.
import { readJson } from '../lib/auth.js';
import { isAdmin } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { fail, json, nowIso, optDate, str, todayIn } from '../lib/util.js';
import { plusDays } from './docs.js';

export const CAPA_STATUS = ['open', 'doing', 'done', 'verified'];
// Days a new corrective action gets, until someone sets its date.
export const CAPA_DAYS = 14;
const LIVE = "status IN ('open', 'doing')";

// One action per failed line of a round, in a single statement. rows: [{ t: title, d: note, s: standard code, c: chapter }].
export const capaFromRoundStmt = (env, x) =>
  env.DB.prepare(
    `INSERT INTO capa (source, round_id, title, detail, location_id, department_id, chapter, std_code, due, status, created_by, created_at, updated_at)
     SELECT 'round', ?1, json_extract(value, '$.t'), json_extract(value, '$.d'), ?2, ?3, json_extract(value, '$.c'), json_extract(value, '$.s'), ?4, 'open', ?5, ?6, ?6
       FROM json_each(?7)`,
  ).bind(x.roundId, x.location_id || null, x.department_id || null, x.due, x.by || null, x.now, JSON.stringify(x.rows));

// The numbers on the home page.
export async function capaHome(env, today) {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(${LIVE}), 0) AS open, COALESCE(SUM(${LIVE} AND due < ?), 0) AS late FROM capa`).bind(today).first();
  return { open: r.open || 0, late: r.late || 0 };
}

const SELECT = `SELECT c.*, l.name_ar AS loc_ar, l.name_en AS loc_en, d.name_ar AS dept_ar, d.name_en AS dept_en,
       f.name_ar AS form_ar, f.name_en AS form_en
  FROM capa c LEFT JOIN locations l ON l.id = c.location_id LEFT JOIN departments d ON d.id = c.department_id
  LEFT JOIN rounds r ON r.id = c.round_id LEFT JOIN round_forms f ON f.id = r.form_id`;

export async function handleCapa(request, env, url, seg, method, user) {
  const role = user.quality || 'none';
  if (role === 'none') fail(403, 'forbidden');
  const manager = isAdmin(user) || role === 'manager';
  const editor = manager || role === 'assessor';
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const id = /^\d+$/.test(seg[1] || '') ? Number(seg[1]) : null;

  const readBody = async (old) => {
    const body = await readJson(request);
    const pickStr = (k, n) => (body[k] === undefined && old ? old[k] : str(body[k], n) || null);
    const next = {
      title: pickStr('title', 500),
      detail: pickStr('detail', 2000),
      owner: pickStr('owner', 150),
      cause: pickStr('cause', 2000),
      action: pickStr('action', 2000),
      chapter: (pickStr('chapter', 6) || '').toUpperCase() || null,
      std_code: (pickStr('std_code', 30) || '').replace(/\s+/g, '').toUpperCase() || null,
      due: body.due === undefined && old ? old.due : optDate(body.due) || null,
      department_id: body.department_id === undefined && old ? old.department_id : Number(body.department_id) || null,
      status: body.status === undefined && old ? old.status : str(body.status, 10) || 'open',
    };
    if (!next.title) fail(400, 'name_required');
    if (!CAPA_STATUS.includes(next.status)) fail(400, 'capa_bad_status');
    if (next.chapter && !(await env.DB.prepare("SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?").bind(next.chapter).first())) fail(400, 'std_bad_chapter');
    // Closing needs what was done; only a quality manager confirms it worked, or reopens a confirmed one.
    if ((next.status === 'done' || next.status === 'verified') && !next.action) fail(400, 'capa_action_required');
    if ((next.status === 'verified' || (old && old.status === 'verified')) && next.status !== (old && old.status) && !manager) fail(403, 'forbidden');
    return next;
  };

  if (method === 'GET' && seg.length === 1) {
    const [{ results: rows }, { results: chapters }, { results: departments }] = await Promise.all([
      env.DB.prepare(`${SELECT} ORDER BY CASE WHEN c.${LIVE} THEN 0 ELSE 1 END, c.due, c.id DESC LIMIT 3000`).all(),
      env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' AND active = 1 ORDER BY sort, code").all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
    ]);
    return json({ capa: rows, chapters, departments, today, can_edit: editor, can_verify: manager });
  }

  if (method === 'POST' && seg.length === 1) {
    if (!editor) fail(403, 'forbidden');
    const next = await readBody(null);
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO capa (source, title, detail, department_id, chapter, std_code, owner, due, status, cause, action, done_at, done_by, created_by, created_at, updated_at)
       VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(next.title, next.detail, next.department_id, next.chapter, next.std_code, next.owner, next.due || plusDays(today, CAPA_DAYS), next.status === 'verified' ? 'done' : next.status,
        next.cause, next.action, next.status === 'done' ? now : null, next.status === 'done' ? user.name : null, user.name, now, now)
      .run();
    const newId = res.meta.last_row_id;
    await logStmt(env, user, 'create', 'capa', newId, next.title).run();
    return json({ ok: true, id: newId });
  }

  const old = id !== null ? await env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first() : null;
  if (!old) fail(404, 'not_found');

  if (method === 'GET' && seg.length === 2) return json({ capa: old, can_edit: editor, can_verify: manager });

  if (method === 'PUT' && seg.length === 2) {
    if (!editor) fail(403, 'forbidden');
    const next = await readBody(old);
    const now = nowIso();
    const moved = next.status !== old.status;
    const done = next.status === 'done' || next.status === 'verified';
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE capa SET title = ?, detail = ?, department_id = ?, chapter = ?, std_code = ?, owner = ?, due = ?, status = ?, cause = ?, action = ?,
                done_at = ?, done_by = ?, verified_at = ?, verified_by = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        next.title, next.detail, next.department_id, next.chapter, next.std_code, next.owner, next.due, next.status, next.cause, next.action,
        done ? (moved && !old.done_at ? now : old.done_at) : null,
        done ? (moved && !old.done_at ? user.name : old.done_by) : null,
        next.status === 'verified' ? (moved ? now : old.verified_at) : null,
        next.status === 'verified' ? (moved ? user.name : old.verified_by) : null,
        now, id,
      ),
      logStmt(env, user, 'update', 'capa', id, next.title, changes(old, next, ['title', 'owner', 'due', 'status', 'chapter', 'std_code'])),
    ]);
    return json({ ok: true });
  }

  if (method === 'DELETE' && seg.length === 2) {
    if (!manager) fail(403, 'forbidden');
    await env.DB.batch([env.DB.prepare('DELETE FROM capa WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'capa', id, old.title)]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

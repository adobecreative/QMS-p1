// Patient experience: complaints, suggestions and thanks (a place's QR code, or staff for a patient), and the
// satisfaction survey. Quality sends a complaint to a person for a reply (working days), then closes it with what
// the patient is told; the tracking link shows where it stands. The survey takes no name: answers 1-5 per question.
import { getUser, readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { sendPush } from '../lib/push.js';
import { escHtml, fail, json, nowIso, sha256Hex, str, toHex, todayIn } from '../lib/util.js';
import { plusDays } from './docs.js';
import { plusWorkdays } from './ovr.js';
import { hashIp } from './tickets.js';

export const PEX_KINDS = ['complaint', 'suggestion', 'praise'];
export const PEX_CATS = ['access', 'waiting', 'staff', 'communication', 'care', 'cleanliness', 'food', 'billing', 'privacy', 'other'];
export const PEX_STATUS = ['new', 'routed', 'replied', 'closed'];
const PER_HOUR = 20;
// Questions to start from; quality edits them after.
export const SURVEY_STARTER = [
  ['سهولة الحصول على الموعد والخدمة', 'Ease of getting an appointment and service'],
  ['وقت الانتظار', 'Waiting time'],
  ['تعامل الموظفين واحترامهم', 'Staff courtesy and respect'],
  ['شرح الطبيب والتمريض لحالتك', 'How doctors and nurses explained your care'],
  ['النظافة والراحة', 'Cleanliness and comfort'],
  ['تقييمك العام للخدمة', 'Overall rating of the service'],
];
export const daysOf = (s) => ({ reply: Math.max(1, Number(s.pex_reply_days) || 3), close: Math.max(1, Number(s.pex_close_days) || 14) });
const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

export async function seedSurvey(env) {
  if (await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = 'pex_q_seeded'").first()) return;
  const now = nowIso();
  await env.DB.batch([
    ...SURVEY_STARTER.map(([ar, en], i) => env.DB.prepare('INSERT INTO survey_questions (text_ar, text_en, sort, active, created_at) VALUES (?, ?, ?, 1, ?)').bind(ar, en, (i + 1) * 10, now)),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('pex_q_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"),
  ]);
}

export function pexRole(u) {
  const q = u.quality || 'none';
  const manager = q === 'admin' || q === 'manager';
  const officer = manager || q === 'assessor';
  return { manager, officer, viewer: officer || q === 'viewer' };
}
export async function pexAccess(env, u) {
  const r = pexRole(u);
  if (r.manager) return 'manager';
  if (r.officer) return 'officer';
  if (r.viewer) return 'viewer';
  return (await env.DB.prepare('SELECT 1 AS x FROM pex WHERE routed_to = ? LIMIT 1').bind(u.id).first()) ? 'member' : 'none';
}

/* ------------------------------ notifications ------------------------------ */

const MAIL = {
  ar: {
    dir: 'rtl',
    kind: { new: 'شكوى جديدة', routed: 'شكوى محوّلة إليك للرد', replied: 'تم الرد على شكوى', late: 'تذكير: شكوى متأخرة' },
    labels: { due: 'الموعد', dept: 'القسم' },
    open: 'فتح الشكوى',
    footer: (app) => `رسالة تلقائية من ${app}.`,
  },
  en: {
    dir: 'ltr',
    kind: { new: 'New complaint', routed: 'Complaint sent to you for a reply', replied: 'Complaint answered', late: 'Reminder: complaint overdue' },
    labels: { due: 'Due', dept: 'Department' },
    open: 'Open the complaint',
    footer: (app) => `Automatic message from ${app}.`,
  },
};

async function notifyPex(env, settings, userIds, kind, p, due) {
  const ids = [...new Set(userIds.filter((v) => Number.isInteger(v) && v > 0))];
  if (!ids.length) return;
  const { results: people } = await env.DB.prepare(`SELECT id, email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const path = '/#/pex/pexs/' + p.id;
  const jobs = [];
  if (people.length && mailReady(settings)) {
    const mail = bothLangs(settings, (s) => {
      const L = MAIL[s.email_lang === 'en' ? 'en' : 'ar'];
      const app = appName(s, s.email_lang);
      const align = L.dir === 'rtl' ? 'right' : 'left';
      const row = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#6e6553;text-align:${align}">${escHtml(L.labels[k])}</td><td style="padding:4px 10px;text-align:${align}">${escHtml(v)}</td></tr>` : '');
      const dept = s.email_lang === 'en' ? p.dept_en || p.dept_ar : p.dept_ar;
      const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
        <p style="font-size:16px;font-weight:bold">${escHtml(L.kind[kind])} <span dir="ltr">#${p.id}</span></p>
        <table style="border-collapse:collapse">${row('dept', dept)}${row('due', due)}</table>
        <p style="margin:20px 0"><a href="${escHtml((s.site_url || '') + path)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
      return { subject: `${L.kind[kind]} #${p.id} - ${app}`, html };
    });
    jobs.push(sendMail(settings, people.map((x) => ({ to: x.email, ...mail }))));
  }
  jobs.push(sendPush(env, ids, (lang) => ({ title: `${MAIL[lang === 'en' ? 'en' : 'ar'].kind[kind]} #${p.id}`, body: due || '', url: path, tag: 'pex-' + p.id })));
  await Promise.all(jobs.map((x) => x.catch((e) => console.error('pex notify', e))));
}
const officerIds = async (env) => (await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role IN ('manager', 'assessor')").all()).results.map((r) => r.id);

/* --------------------------------- reading --------------------------------- */

const SELECT = `SELECT p.*, d.name_ar AS dept_ar, d.name_en AS dept_en, l.name_ar AS loc_ar, l.name_en AS loc_en, u.name AS to_name, u.name_en AS to_name_en
  FROM pex p LEFT JOIN departments d ON d.id = p.department_id LEFT JOIN locations l ON l.id = p.location_id LEFT JOIN users u ON u.id = p.routed_to`;
const getPex = (env, id) => env.DB.prepare(`${SELECT} WHERE p.id = ?`).bind(id).first();

function pexOut(p, today, full) {
  const due = p.status === 'routed' ? p.reply_due : p.status !== 'closed' ? p.close_due : null;
  const out = {
    id: p.id, kind: p.kind, category: p.category, status: p.status, source: p.source, department_id: p.department_id, dept_ar: p.dept_ar || '', dept_en: p.dept_en || '',
    loc_ar: p.loc_ar || '', loc_en: p.loc_en || '', description: p.description, routed_to: p.routed_to, to_name: p.to_name || '', to_name_en: p.to_name_en || '',
    due, late: !!due && due < today, created_at: p.created_at, closed_at: p.closed_at,
  };
  if (full)
    Object.assign(out, {
      patient_name: p.patient_name || '', patient_mrn: p.patient_mrn || '', phone: p.phone || '', route_note: p.route_note || '',
      reply: p.reply || '', replied_at: p.replied_at, replied_by: p.replied_by || '', resolution: p.resolution || '', closed_by: p.closed_by || '',
      reply_due: p.reply_due, close_due: p.close_due, created_by: p.created_by || '',
    });
  return out;
}

/* ------------------------------ public routes ------------------------------ */

// /api/public/pex/...: the form and survey from a place's QR code, and the tracking link.
export async function handlePublicPex(request, env, url, seg, method, ctx) {
  // GET /public/pex/form?loc=<code>: the place, departments and survey questions.
  if (method === 'GET' && seg[2] === 'form' && seg.length === 3) {
    await seedSurvey(env);
    const code = str(url.searchParams.get('loc'), 40);
    const [{ results: departments }, loc, { results: questions }] = await Promise.all([
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 0 OR is_team IS NULL ORDER BY name_ar').all(),
      code ? env.DB.prepare('SELECT id, name_ar, name_en, department_id FROM locations WHERE code = ? AND active = 1').bind(code).first() : null,
      env.DB.prepare('SELECT id, text_ar, text_en FROM survey_questions WHERE active = 1 ORDER BY sort, id').all(),
    ]);
    return json({ departments, location: loc || null, questions, kinds: PEX_KINDS, categories: PEX_CATS });
  }

  const limit = async (tag) => {
    const ipHash = await hashIp(request);
    const hits = await env.DB.prepare('SELECT COUNT(*) AS n FROM public_hits WHERE ip_hash = ? AND at > ?').bind(tag + ipHash, new Date(Date.now() - 3600000).toISOString()).first();
    if (hits.n >= PER_HOUR) fail(429, 'too_many_requests');
    return env.DB.prepare('INSERT INTO public_hits (ip_hash, at) VALUES (?, ?)').bind(tag + ipHash, nowIso());
  };
  const place = async (code) => (code ? await env.DB.prepare('SELECT id, department_id FROM locations WHERE code = ? AND active = 1').bind(code).first() : null);

  // POST /public/pex: a complaint, suggestion or thanks.
  if (method === 'POST' && seg.length === 2) {
    const b = await readJson(request);
    if (str(b.website, 100)) return json({ ok: true, id: 0 });
    const hit = await limit('pex:');
    const user = await getUser(request, env);
    const settings = await getSettings(env);
    const today = todayIn(settings.timezone);
    const kind = str(b.kind, 12);
    if (!PEX_KINDS.includes(kind)) fail(400, 'pex_bad_kind');
    const category = PEX_CATS.includes(b.category) ? b.category : 'other';
    const description = str(b.description, 3000);
    if (description.length < 5) fail(400, 'ovr_desc_required');
    const phone = str(b.phone, 20).replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x660));
    if (phone && !/^\+?[0-9 ]{7,20}$/.test(phone)) fail(400, 'pex_bad_phone');
    const name = str(b.patient_name, 120);
    if (kind === 'complaint' && (!name || !phone)) fail(400, 'pex_contact_required');
    const loc = await place(str(b.loc, 40));
    let dept = toId(b.department_id) || (loc && loc.department_id) || null;
    if (dept && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(dept).first())) dept = null;
    const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const now = nowIso();
    const days = daysOf(settings);
    const res = await env.DB.prepare(
      `INSERT INTO pex (kind, category, status, source, department_id, location_id, patient_name, patient_mrn, phone, description, close_due, track_hash, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(kind, category, kind === 'complaint' ? 'new' : 'new', user ? 'staff' : 'qr', dept, loc ? loc.id : null, name || null, str(b.patient_mrn, 40) || null, phone || null, description,
        kind === 'complaint' ? plusDays(today, days.close) : null, await sha256Hex(token), user ? user.name : null, now, now)
      .run();
    const id = res.meta.last_row_id;
    await env.DB.batch([hit, logStmt(env, user || null, 'create', 'pex', id, '#' + id)]);
    if (kind === 'complaint') {
      const job = (async () => notifyPex(env, settings, await officerIds(env), 'new', await getPex(env, id)))();
      if (ctx && ctx.waitUntil) ctx.waitUntil(job);
      else await job;
    }
    return json({ ok: true, id, track: token });
  }

  // POST /public/pex/survey {loc, department_id, answers: {qid: 1-5}, comment}
  if (method === 'POST' && seg[2] === 'survey' && seg.length === 3) {
    const b = await readJson(request);
    if (str(b.website, 100)) return json({ ok: true });
    const hit = await limit('svy:');
    const { results: qs } = await env.DB.prepare('SELECT id FROM survey_questions WHERE active = 1').all();
    const answers = {};
    for (const q of qs) {
      const v = Number((b.answers || {})[q.id]);
      if (Number.isInteger(v) && v >= 1 && v <= 5) answers[q.id] = v;
    }
    const vals = Object.values(answers);
    if (!vals.length) fail(400, 'pex_no_answers');
    const loc = await place(str(b.loc, 40));
    let dept = toId(b.department_id) || (loc && loc.department_id) || null;
    if (dept && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(dept).first())) dept = null;
    const now = nowIso();
    const settings = await getSettings(env);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO survey_responses (location_id, department_id, answers, n, satisfied, comment, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(loc ? loc.id : null, dept, JSON.stringify(answers), vals.length, vals.filter((v) => v >= 4).length, str(b.comment, 1000) || null, todayIn(settings.timezone), now),
      hit,
    ]);
    return json({ ok: true });
  }

  // GET /public/pex/<id>?k=<token>: where it stands, and what the patient is told once closed.
  if (method === 'GET' && seg.length === 3 && /^\d+$/.test(seg[2])) {
    const k = str(url.searchParams.get('k'), 64);
    if (!/^[0-9a-f]{32}$/.test(k)) fail(404, 'not_found');
    const p = await env.DB.prepare('SELECT * FROM pex WHERE id = ? AND track_hash = ?').bind(Number(seg[2]), await sha256Hex(k)).first();
    if (!p) fail(404, 'not_found');
    return json({ pex: { id: p.id, kind: p.kind, status: p.status, created_at: p.created_at, closed_at: p.closed_at, resolution: p.status === 'closed' ? p.resolution || '' : '' } });
  }
  fail(404, 'not_found');
}

/* ----------------------------- signed-in routes ---------------------------- */

export async function handlePex(request, env, url, seg, method, user, ctx) {
  const role = pexRole(user);
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const days = daysOf(settings);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);

  /* settings: deadlines and survey questions (quality manager) */
  if (seg[1] === 'settings') {
    if (!role.manager) fail(403, 'forbidden');
    await seedSurvey(env);
    if (method === 'GET' && seg.length === 2) {
      const { results } = await env.DB.prepare('SELECT * FROM survey_questions ORDER BY sort, id').all();
      return json({ reply_days: days.reply, close_days: days.close, questions: results });
    }
    if (method === 'PUT' && seg.length === 2) {
      const b = await readJson(request);
      const n = (v, max) => {
        const x = Number(v);
        if (!Number.isInteger(x) || x < 1 || x > max) fail(400, 'inv_bad_days');
        return x;
      };
      const reply = n(b.reply_days, 30);
      const close = n(b.close_days, 90);
      const set = (k, v) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v));
      await env.DB.batch([set('pex_reply_days', reply), set('pex_close_days', close), logStmt(env, user, 'update', 'settings', null, 'pex', { pex_days: [`${days.reply}/${days.close}`, `${reply}/${close}`] })]);
      return json({ ok: true });
    }
    // Questions: POST adds, PUT /<id> edits (text, active), DELETE /<id> removes one with no answers.
    if (seg[2] === 'questions') {
      const qid = toId(seg[3]);
      if (method === 'POST' && seg.length === 3) {
        const b = await readJson(request);
        const ar = str(b.text_ar, 200);
        const en = str(b.text_en, 200);
        if (!ar || !en) fail(400, 'name_required');
        const m = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM survey_questions').first();
        await env.DB.prepare('INSERT INTO survey_questions (text_ar, text_en, sort, active, created_at) VALUES (?, ?, ?, 1, ?)').bind(ar, en, m.m + 10, nowIso()).run();
        return json({ ok: true });
      }
      const q = qid ? await env.DB.prepare('SELECT * FROM survey_questions WHERE id = ?').bind(qid).first() : null;
      if (!q) fail(404, 'not_found');
      if (method === 'PUT' && seg.length === 4) {
        const b = await readJson(request);
        const ar = b.text_ar === undefined ? q.text_ar : str(b.text_ar, 200);
        const en = b.text_en === undefined ? q.text_en : str(b.text_en, 200);
        if (!ar || !en) fail(400, 'name_required');
        await env.DB.prepare('UPDATE survey_questions SET text_ar = ?, text_en = ?, active = ? WHERE id = ?').bind(ar, en, b.active === undefined ? q.active : b.active ? 1 : 0, qid).run();
        return json({ ok: true });
      }
      if (method === 'DELETE' && seg.length === 4) {
        const used = await env.DB.prepare("SELECT 1 AS x FROM survey_responses WHERE json_extract(answers, '$.' || ?) IS NOT NULL LIMIT 1").bind(String(qid)).first();
        if (used) fail(409, 'pex_q_used');
        await env.DB.prepare('DELETE FROM survey_questions WHERE id = ?').bind(qid).run();
        return json({ ok: true });
      }
    }
    fail(405, 'method_not_allowed');
  }

  // GET /pex/report?from=2026-01&to=2026-11: counts and the survey, for quality.
  if (method === 'GET' && seg[1] === 'report' && seg.length === 2) {
    if (!role.viewer) fail(403, 'forbidden');
    await seedSurvey(env);
    const M = /^\d{4}-(0[1-9]|1[0-2])$/;
    const now = today.slice(0, 7);
    let to = M.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : now;
    let from = M.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : `${Number(to.slice(0, 4)) - (to.slice(5) === '12' ? 0 : 1)}-${String((Number(to.slice(5)) % 12) + 1).padStart(2, '0')}`;
    if (from > to) [from, to] = [to, from];
    const w = 'substr(p.created_at, 1, 7) >= ?1 AND substr(p.created_at, 1, 7) <= ?2';
    const sw = 'substr(day, 1, 7) >= ?1 AND substr(day, 1, 7) <= ?2';
    const q = (sql) => env.DB.prepare(sql).bind(from, to);
    const [tot, kinds, cats, depts, months, svy, rows, qs] = await env.DB.batch([
      q(`SELECT COALESCE(SUM(kind = 'complaint'), 0) AS complaints, COALESCE(SUM(kind = 'suggestion'), 0) AS suggestions, COALESCE(SUM(kind = 'praise'), 0) AS praise,
           COALESCE(SUM(kind = 'complaint' AND status = 'closed'), 0) AS closed, COALESCE(SUM(kind = 'complaint' AND status = 'closed' AND substr(closed_at, 1, 10) <= close_due), 0) AS on_time,
           COALESCE(SUM(kind = 'complaint' AND status <> 'closed'), 0) AS open,
           AVG(CASE WHEN kind = 'complaint' AND status = 'closed' THEN julianday(substr(closed_at, 1, 10)) - julianday(substr(created_at, 1, 10)) END) AS avg_days
         FROM pex p WHERE ${w}`),
      q(`SELECT kind AS k, COUNT(*) AS n FROM pex p WHERE ${w} GROUP BY kind`),
      q(`SELECT category AS k, COUNT(*) AS n FROM pex p WHERE ${w} AND kind = 'complaint' GROUP BY category ORDER BY n DESC`),
      q(`SELECT d.id, d.name_ar, d.name_en, COUNT(*) AS n FROM pex p JOIN departments d ON d.id = p.department_id WHERE ${w} AND p.kind = 'complaint' GROUP BY d.id ORDER BY n DESC LIMIT 10`),
      q(`SELECT substr(p.created_at, 1, 7) AS m, COALESCE(SUM(kind = 'complaint'), 0) AS n FROM pex p WHERE ${w} GROUP BY m`),
      q(`SELECT COUNT(*) AS responses, COALESCE(SUM(n), 0) AS answers, COALESCE(SUM(satisfied), 0) AS satisfied FROM survey_responses WHERE ${sw}`),
      q(`SELECT answers, department_id FROM survey_responses WHERE ${sw} LIMIT 20000`),
      env.DB.prepare('SELECT id, text_ar, text_en, active FROM survey_questions ORDER BY sort, id'),
    ]);
    // Per question: the average and the share of 4-5.
    const per = {};
    for (const r of rows.results) {
      let a = {};
      try {
        a = JSON.parse(r.answers);
      } catch {}
      for (const [k, v] of Object.entries(a)) {
        const x = (per[k] = per[k] || { n: 0, sum: 0, sat: 0 });
        x.n++;
        x.sum += v;
        if (v >= 4) x.sat++;
      }
    }
    const list = [];
    for (let m = from; m <= to; ) {
      list.push(m);
      const [y, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }
    const byM = new Map(months.results.map((x) => [x.m, x.n]));
    const T = tot.results[0];
    return json({
      from, to, this_month: now,
      totals: { ...T, avg_days: T.avg_days === null || T.avg_days === undefined ? null : Math.round(T.avg_days * 10) / 10, ...svy.results[0] },
      kinds: kinds.results, categories: cats.results, departments: depts.results,
      months: list.map((m) => ({ m, n: byM.get(m) || 0 })),
      questions: qs.results.filter((x) => x.active || per[x.id]).map((x) => ({ id: x.id, text_ar: x.text_ar, text_en: x.text_en, n: (per[x.id] || {}).n || 0, avg: per[x.id] ? Math.round((per[x.id].sum / per[x.id].n) * 10) / 10 : null, pct: per[x.id] ? Math.round((per[x.id].sat / per[x.id].n) * 100) : null })),
    });
  }

  // GET /pex/people: the accounts a complaint can be sent to.
  if (method === 'GET' && seg[1] === 'people' && seg.length === 2) {
    if (!role.officer) fail(403, 'forbidden');
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.name_en, d.name_ar AS dept_ar, d.name_en AS dept_en FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.active = 1 AND u.id <> (SELECT MIN(id) FROM users) ORDER BY u.name`,
    ).all();
    return json({ people: results });
  }

  if (method === 'GET' && seg.length === 1) {
    const { results } = role.viewer
      ? await env.DB.prepare(`${SELECT} ORDER BY CASE WHEN p.status <> 'closed' AND p.kind = 'complaint' THEN 0 ELSE 1 END, p.id DESC LIMIT 3000`).all()
      : await env.DB.prepare(`${SELECT} WHERE p.routed_to = ? ORDER BY CASE WHEN p.status = 'routed' THEN 0 ELSE 1 END, p.id DESC LIMIT 500`).bind(user.id).all();
    return json({ pex: results.map((p) => pexOut(p, today, false)), today, role: { manager: role.manager, officer: role.officer, viewer: role.viewer } });
  }

  const id = toId(seg[1]);
  const p = id ? await getPex(env, id) : null;
  if (!p || !(role.viewer || p.routed_to === user.id)) fail(404, 'not_found');
  const mine = p.routed_to === user.id;

  if (method === 'GET' && seg.length === 2) {
    const out = pexOut(p, today, true);
    out.can = { route: role.officer && p.kind === 'complaint' && p.status !== 'closed', reply: mine && p.status === 'routed', close: role.officer && p.status !== 'closed', reopen: role.manager && p.status === 'closed', delete: role.manager };
    return json({ pex: out });
  }

  // POST /pex/<id>/route {user_id, note}: send a complaint to a person for a reply.
  if (method === 'POST' && seg[2] === 'route' && seg.length === 3) {
    if (!role.officer) fail(403, 'forbidden');
    if (p.kind !== 'complaint' || p.status === 'closed') fail(409, 'pex_closed');
    const b = await readJson(request);
    const to = toId(b.user_id);
    if (!to || !(await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(to).first())) fail(400, 'invalid_user');
    const due = plusWorkdays(today, days.reply);
    await env.DB.batch([
      env.DB.prepare("UPDATE pex SET status = 'routed', routed_to = ?, route_note = ?, reply_due = ?, routed_at = ?, reminded_on = NULL, updated_at = ? WHERE id = ?").bind(to, str(b.note, 1000) || null, due, nowIso(), nowIso(), id),
      logStmt(env, user, 'route', 'pex', id, '#' + id, { to: [p.routed_to, to] }),
    ]);
    later(notifyPex(env, settings, [to], 'routed', p, due));
    return json({ ok: true, due });
  }

  // POST /pex/<id>/reply {reply}: the person it was sent to answers; it goes back to quality.
  if (method === 'POST' && seg[2] === 'reply' && seg.length === 3) {
    if (!mine || p.status !== 'routed') fail(403, 'forbidden');
    const b = await readJson(request);
    const reply = str(b.reply, 3000);
    if (reply.length < 3) fail(400, 'pex_reply_required');
    await env.DB.batch([
      env.DB.prepare("UPDATE pex SET status = 'replied', reply = ?, replied_at = ?, replied_by = ?, updated_at = ? WHERE id = ?").bind(reply, nowIso(), user.name, nowIso(), id),
      logStmt(env, user, 'reply', 'pex', id, '#' + id),
    ]);
    later(notifyPex(env, settings, await officerIds(env), 'replied', p));
    return json({ ok: true });
  }

  // POST /pex/<id>/close {resolution}: what the patient is told; reopen with {reopen: true} (quality manager).
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    const b = await readJson(request);
    if (b.reopen) {
      if (!role.manager || p.status !== 'closed') fail(403, 'forbidden');
      await env.DB.batch([
        env.DB.prepare("UPDATE pex SET status = CASE WHEN reply IS NOT NULL THEN 'replied' WHEN routed_to IS NOT NULL THEN 'routed' ELSE 'new' END, closed_at = NULL, closed_by = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id),
        logStmt(env, user, 'reopen', 'pex', id, '#' + id),
      ]);
      return json({ ok: true });
    }
    if (!role.officer || p.status === 'closed') fail(403, 'forbidden');
    const resolution = str(b.resolution, 3000);
    if (p.kind === 'complaint' && resolution.length < 3) fail(400, 'pex_resolution_required');
    await env.DB.batch([
      env.DB.prepare("UPDATE pex SET status = 'closed', resolution = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?").bind(resolution || null, nowIso(), user.name, nowIso(), id),
      logStmt(env, user, 'close', 'pex', id, '#' + id),
    ]);
    return json({ ok: true });
  }

  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    await env.DB.batch([env.DB.prepare('DELETE FROM pex WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'pex', id, '#' + id)]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

/* ------------------------------ home and reminders ----------------------------- */

export async function pexHome(env, user, today) {
  const role = pexRole(user);
  if (role.viewer) {
    const r = await env.DB.prepare(
      `SELECT COALESCE(SUM(status = 'new'), 0) AS new, COALESCE(SUM(status <> 'closed'), 0) AS open,
              COALESCE(SUM((status = 'routed' AND reply_due < ?1) OR (status <> 'closed' AND close_due < ?1)), 0) AS late FROM pex WHERE kind = 'complaint'`,
    ).bind(today).first();
    return { new: r.new, open: r.open, late: r.late };
  }
  const r = await env.DB.prepare("SELECT COUNT(*) AS mine, COALESCE(SUM(reply_due < ?), 0) AS late FROM pex WHERE routed_to = ? AND status = 'routed'").bind(today, user.id).first();
  return r.mine ? { mine: r.mine, late: r.late } : null;
}

// Daily: a late reply reminds the person it was sent to; a complaint past its closing date reminds quality. Once a day each.
export async function runPexReminders(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results } = await env.DB.prepare(
    `${SELECT} WHERE p.kind = 'complaint' AND p.status <> 'closed' AND (p.reminded_on IS NULL OR p.reminded_on < ?1)
       AND ((p.status = 'routed' AND p.reply_due < ?1) OR p.close_due < ?1) ORDER BY p.id LIMIT 30`,
  ).bind(today).all();
  const officers = results.length ? await officerIds(env) : [];
  for (const p of results) {
    const replyLate = p.status === 'routed' && p.reply_due < today;
    await notifyPex(env, settings, replyLate ? [p.routed_to] : officers, 'late', p, replyLate ? p.reply_due : p.close_due);
  }
  if (results.length) await env.DB.prepare(`UPDATE pex SET reminded_on = ? WHERE id IN (${results.map((p) => p.id).join(',')})`).bind(today).run();
  return { late: results.length };
}

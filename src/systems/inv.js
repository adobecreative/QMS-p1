// Investigations: administrative and any other investigation, run by quality and human resources. Unlike an incident
// report (OVR, for improvement only), an investigation can end in a penalty, from a notice to dismissal.
// Flow: opened with the person investigated and a committee -> the committee sends questions to the person and to
// witnesses, who answer in the system (or the committee writes what it heard) -> the committee writes the minutes
// (facts, finding, recommendation) -> the person reads them and replies (their right of reply) -> the approver (the
// human resources manager by default) decides -> closed. Each stage has a deadline in working days, from the settings.
// Only the officers (quality managers, the approver, the human resources staff named in the settings), the committee
// and the person themselves see an investigation; a witness sees only the questions put to them.
// Emails and push notifications carry only the number and the stage, never the subject or the names.
import { readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { sendPush } from '../lib/push.js';
import { checkLang, escHtml, fail, json, nowIso, str, todayIn } from '../lib/util.js';
import { FILE_TYPES } from './meetings.js';
import { plusWorkdays } from './ovr.js';

export const INV_STATUS = ['open', 'reply', 'decision', 'closed'];
export const INV_OUTCOMES = ['cleared', 'penalty'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 30;
const MAX_QUESTIONS = 20;

// Starter penalties, after the Saudi Labour Law (article 66). [ar, en, takes days]. Added once; edited from the settings.
export const PENALTY_STARTER = [
  ['لفت نظر', 'Notice', 0],
  ['إنذار كتابي', 'Written warning', 0],
  ['خصم من الراتب', 'Salary deduction', 1],
  ['الحرمان من العلاوة أو الترقية', 'No raise or promotion', 0],
  ['إيقاف عن العمل بدون أجر', 'Suspension without pay', 1],
  ['الفصل من الخدمة', 'Dismissal', 0],
];

export async function seedPenalties(env) {
  if (await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = 'inv_pen_seeded' AND value <> ''").first()) return;
  const now = nowIso();
  await env.DB.batch([
    ...PENALTY_STARTER.map(([ar, en, days], i) => env.DB.prepare('INSERT INTO inv_penalties (name_ar, name_en, days, sort, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(ar, en, days, (i + 1) * 10, now)),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('inv_pen_seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now),
  ]);
}

/* ---------------------------------- roles ---------------------------------- */

const idList = (v) => String(v || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);
export const approverOf = (s) => Number(s.inv_approver) || Number(s.ovr_hr_user) || null;
export const daysOf = (s) => ({
  answer: Math.max(1, Number(s.inv_answer_days) || 2),
  minutes: Math.max(1, Number(s.inv_minutes_days) || 5),
  decision: Math.max(1, Number(s.inv_decision_days) || 3),
});

// officer: opens and runs every investigation (quality managers and the system admins, the approver, human resources).
// approver: decides (with no approver named, the quality managers do). manager: settings and deleting.
export function invRole(u, s) {
  const q = u.quality || 'none';
  const qm = q === 'admin' || q === 'manager';
  const approver = approverOf(s);
  const isApprover = approver === u.id;
  return {
    officer: qm || isApprover || idList(s.inv_staff).includes(u.id),
    approver: isApprover || (!approver && qm),
    manager: qm || isApprover,
  };
}

// What the portal shows: manager, officer, member (takes part in at least one), or none.
export async function invAccess(env, u, s) {
  const r0 = invRole(u, s);
  if (r0.manager) return 'manager';
  if (r0.officer) return 'officer';
  const r = await env.DB.prepare('SELECT 1 AS x FROM inv_people WHERE user_id = ?1 UNION SELECT 1 FROM inv_questions WHERE to_user_id = ?1 LIMIT 1').bind(u.id).first();
  return r ? 'member' : 'none';
}

/* ------------------------------ notifications ------------------------------ */

const MAIL = {
  ar: {
    dir: 'rtl',
    kind: {
      new: 'تحقيق جديد', committee: 'أُضفت إلى لجنة تحقيق', question: 'أسئلة تحقيق موجهة إليك', answered: 'تم الرد على أسئلة التحقيق',
      minutes: 'محضر التحقيق جاهز لردك', replied: 'تم الرد على محضر التحقيق', decision: 'تحقيق بانتظار القرار', returned: 'أعيد محضر التحقيق للجنة',
      closed: 'صدر قرار التحقيق', late: 'تذكير: تحقيق متأخر', late_q: 'تذكير: أسئلة تحقيق بانتظار ردك',
    },
    labels: { due: 'الموعد', stage: 'المرحلة' },
    stage: { open: 'التحقيق', reply: 'رد الموظف', decision: 'القرار', closed: 'مغلق' },
    open: 'فتح التحقيق',
    footer: (app) => `رسالة تلقائية من ${app}. محتوى التحقيق سري.`,
  },
  en: {
    dir: 'ltr',
    kind: {
      new: 'New investigation', committee: 'You were added to an investigation committee', question: 'Investigation questions for you', answered: 'Investigation questions answered',
      minutes: 'Investigation minutes ready for your reply', replied: 'Reply on the investigation minutes', decision: 'Investigation waiting for a decision', returned: 'Investigation minutes returned to the committee',
      closed: 'Investigation decision issued', late: 'Reminder: investigation overdue', late_q: 'Reminder: investigation questions waiting for you',
    },
    labels: { due: 'Due', stage: 'Stage' },
    stage: { open: 'Investigation', reply: 'Reply', decision: 'Decision', closed: 'Closed' },
    open: 'Open the investigation',
    footer: (app) => `Automatic message from ${app}. Investigations are confidential.`,
  },
};

export async function notifyInv(env, settings, userIds, kind, inv, extra = {}) {
  const ids = [...new Set(userIds.filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return;
  const { results: people } = await env.DB.prepare(`SELECT id, email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const path = '/#/inv/invs/' + inv.id;
  const jobs = [];
  if (people.length && mailReady(settings)) {
    const mail = bothLangs(settings, (s) => {
      const L = MAIL[s.email_lang === 'en' ? 'en' : 'ar'];
      const app = appName(s, s.email_lang);
      const align = L.dir === 'rtl' ? 'right' : 'left';
      const row = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#6e6553;text-align:${align}">${escHtml(L.labels[k])}</td><td style="padding:4px 10px;text-align:${align}">${escHtml(v)}</td></tr>` : '');
      const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
        <p style="font-size:16px;font-weight:bold">${escHtml(L.kind[kind])} <span dir="ltr">#${inv.id}</span></p>
        <table style="border-collapse:collapse">${row('stage', L.stage[extra.stage || inv.status])}${row('due', extra.due)}</table>
        <p style="margin:20px 0"><a href="${escHtml((s.site_url || '') + path)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
      return { subject: `${L.kind[kind]} #${inv.id} - ${app}`, html };
    });
    jobs.push(sendMail(settings, people.map((p) => ({ to: p.email, ...mail }))));
  }
  jobs.push(
    sendPush(env, ids, (lang) => {
      const L = MAIL[lang === 'en' ? 'en' : 'ar'];
      return { title: `${L.kind[kind]} #${inv.id}`, body: [L.stage[extra.stage || inv.status], extra.due].filter(Boolean).join(' · '), url: path, tag: 'inv-' + inv.id };
    }),
  );
  await Promise.all(jobs.map((p) => p.catch((e) => console.error('inv notify', e))));
}

// Everyone who runs investigations: quality managers, the approver and human resources.
async function officerIds(env, s) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role = 'manager'").all();
  return [...results.map((r) => r.id), approverOf(s), ...idList(s.inv_staff)].filter(Boolean);
}
async function approverIds(env, s) {
  const a = approverOf(s);
  if (a) return [a];
  return (await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role = 'manager'").all()).results.map((r) => r.id);
}

/* --------------------------------- reading --------------------------------- */

const SELECT = `SELECT i.*, d.name_ar AS dept_ar, d.name_en AS dept_en,
       rp.name_ar AS rec_pen_ar, rp.name_en AS rec_pen_en, p.name_ar AS pen_ar, p.name_en AS pen_en
  FROM inv i LEFT JOIN departments d ON d.id = i.department_id
  LEFT JOIN inv_penalties rp ON rp.id = i.rec_penalty_id LEFT JOIN inv_penalties p ON p.id = i.penalty_id`;
const getInv = (env, id) => env.DB.prepare(`${SELECT} WHERE i.id = ?`).bind(id).first();

// The date the current stage is due by.
export const dueOf = (i) => (i.status === 'open' ? i.minutes_due : i.status === 'reply' ? i.reply_due : i.status === 'decision' ? i.decision_due : null);

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const stepStmt = (env, id, kind, user, text) => env.DB.prepare('INSERT INTO inv_steps (inv_id, at, kind, by_name, text) VALUES (?, ?, ?, ?, ?)').bind(id, nowIso(), kind, user ? user.name : 'النظام | System', text || null);
const touch = (env, id) => env.DB.prepare('UPDATE inv SET updated_at = ? WHERE id = ?').bind(nowIso(), id);

async function activeUsers(env, ids) {
  const list = [...new Set(ids.map(toId).filter(Boolean))];
  if (!list.length) return [];
  const { results } = await env.DB.prepare(`SELECT id, name, name_en FROM users WHERE active = 1 AND id IN (${list.map(() => '?').join(',')})`).bind(...list).all();
  return list.map((x) => results.find((r) => r.id === x)).filter(Boolean);
}

/* ---------------------------------- routes ---------------------------------- */

export async function handleInv(request, env, url, seg, method, user, ctx) {
  const settings = await getSettings(env);
  const role = invRole(user, settings);
  const today = todayIn(settings.timezone);
  const days = daysOf(settings);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
  await seedPenalties(env);

  /* penalties: everyone in an investigation reads them; the managers edit them */
  if (seg[1] === 'penalties') {
    if (method === 'GET' && seg.length === 2) {
      const { results } = await env.DB.prepare('SELECT p.*, (SELECT COUNT(*) FROM inv WHERE penalty_id = p.id OR rec_penalty_id = p.id) AS used FROM inv_penalties p ORDER BY sort, id').all();
      return json({ penalties: results, can_edit: role.manager });
    }
    if (!role.manager) fail(403, 'forbidden');
    const readPen = async (old) => {
      const body = await readJson(request);
      const next = {
        name_ar: body.name_ar === undefined && old ? old.name_ar : str(body.name_ar, 120),
        name_en: body.name_en === undefined && old ? old.name_en : str(body.name_en, 120),
        days: body.days === undefined && old ? old.days : body.days ? 1 : 0,
        active: body.active === undefined && old ? old.active : body.active === false || body.active === 0 ? 0 : 1,
      };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      checkLang((k) => next[k], ['name_ar'], ['name_en']);
      return next;
    };
    if (method === 'POST' && seg.length === 2) {
      const next = await readPen(null);
      const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM inv_penalties').first();
      const res = await env.DB.prepare('INSERT INTO inv_penalties (name_ar, name_en, days, sort, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(next.name_ar, next.name_en, next.days, max.m + 10, nowIso()).run();
      await logStmt(env, user, 'create', 'inv_penalty', res.meta.last_row_id, next.name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    const pid = toId(seg[2]);
    const old = pid && seg.length === 3 ? await env.DB.prepare('SELECT * FROM inv_penalties WHERE id = ?').bind(pid).first() : null;
    if (!old) fail(404, 'not_found');
    if (method === 'PUT') {
      const next = await readPen(old);
      await env.DB.batch([
        env.DB.prepare('UPDATE inv_penalties SET name_ar = ?, name_en = ?, days = ?, active = ? WHERE id = ?').bind(next.name_ar, next.name_en, next.days, next.active, pid),
        logStmt(env, user, 'update', 'inv_penalty', pid, next.name_ar, changes(old, next, ['name_ar', 'name_en', 'days', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM inv WHERE penalty_id = ?1 OR rec_penalty_id = ?1').bind(pid).first();
      if (used.n) fail(409, 'inv_pen_used');
      await env.DB.batch([env.DB.prepare('DELETE FROM inv_penalties WHERE id = ?').bind(pid), logStmt(env, user, 'delete', 'inv_penalty', pid, old.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* settings: the approver, human resources staff, deadlines and committee absences */
  if (seg[1] === 'settings' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    if (method === 'GET')
      return json({ approver: approverOf(settings), staff: idList(settings.inv_staff), answer_days: days.answer, minutes_days: days.minutes, decision_days: days.decision, absence_after: Number(settings.ovr_absence_after) || 0 });
    if (method === 'PUT') {
      const body = await readJson(request);
      const approver = body.approver ? toId(body.approver) : null;
      if (body.approver && !(await activeUsers(env, [approver])).length) fail(400, 'inv_bad_person');
      const staff = (await activeUsers(env, Array.isArray(body.staff) ? body.staff.slice(0, 30) : [])).map((x) => x.id);
      const num = (v, max) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > max) fail(400, 'inv_bad_days');
        return n;
      };
      const next = { answer: num(body.answer_days, 30), minutes: num(body.minutes_days, 60), decision: num(body.decision_days, 30) };
      const after = Number(body.absence_after);
      if (!Number.isInteger(after) || after < 0 || after > 20) fail(400, 'ovr_bad_absence');
      const set = (k, v) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v));
      const staffText = staff.length ? ',' + staff.join(',') + ',' : '';
      await env.DB.batch([
        set('inv_approver', approver || ''),
        // The old setting (human resources for absence reports) follows, so an empty approver does not fall back to it.
        set('ovr_hr_user', approver || ''),
        set('inv_staff', staffText),
        set('inv_answer_days', next.answer),
        set('inv_minutes_days', next.minutes),
        set('inv_decision_days', next.decision),
        set('ovr_absence_after', after),
        logStmt(env, user, 'update', 'settings', null, 'inv', {
          inv_approver: [String(approverOf(settings) || ''), String(approver || '')],
          inv_staff: [settings.inv_staff, staffText],
          inv_days: [`${days.answer}/${days.minutes}/${days.decision}`, `${next.answer}/${next.minutes}/${next.decision}`],
          ovr_absence_after: [settings.ovr_absence_after, String(after)],
        }),
      ]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  // GET /inv/people: the accounts to pick from (officers, and a committee member choosing a witness).
  if (method === 'GET' && seg[1] === 'people' && seg.length === 2) {
    if (!role.officer && !(await env.DB.prepare("SELECT 1 AS x FROM inv_people WHERE user_id = ? AND role IN ('head', 'member') LIMIT 1").bind(user.id).first())) fail(403, 'forbidden');
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.name_en, u.job_title, u.department_id, d.name_ar AS dept_ar, d.name_en AS dept_en FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.active = 1 AND u.id <> (SELECT MIN(id) FROM users) ORDER BY u.name`,
    ).all();
    const depts = role.officer ? (await env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 0 OR is_team IS NULL ORDER BY name_ar').all()).results : [];
    return json({ people: results, departments: depts });
  }

  /* the list: officers see all; everyone else the ones they take part in or were asked in */
  if (method === 'GET' && seg.length === 1) {
    const { results: rows } = role.officer
      ? await env.DB.prepare(`${SELECT} ORDER BY CASE WHEN i.status <> 'closed' THEN 0 ELSE 1 END, i.id DESC LIMIT 3000`).all()
      : await env.DB.prepare(
          `${SELECT} WHERE i.id IN (SELECT inv_id FROM inv_people WHERE user_id = ?1) OR i.id IN (SELECT inv_id FROM inv_questions WHERE to_user_id = ?1)
            ORDER BY CASE WHEN i.status <> 'closed' THEN 0 ELSE 1 END, i.id DESC LIMIT 500`,
        ).bind(user.id).all();
    const { results: mine } = await env.DB.prepare('SELECT inv_id, role FROM inv_people WHERE user_id = ?').bind(user.id).all();
    const { results: myQs } = await env.DB.prepare('SELECT inv_id, COUNT(*) AS n, MIN(due) AS due FROM inv_questions WHERE to_user_id = ? AND answer IS NULL GROUP BY inv_id').bind(user.id).all();
    const list = rows.map((i) => {
      const my = mine.find((m) => m.inv_id === i.id);
      const q = myQs.find((x) => x.inv_id === i.id);
      const part = role.officer ? 'officer' : my ? my.role : 'witness';
      const due = dueOf(i);
      const out = { id: i.id, status: i.status, source: i.source, created_at: i.created_at, part, my_questions: q ? q.n : 0, my_due: q ? q.due : null };
      if (part !== 'witness') Object.assign(out, { title: i.title, subject_name: i.subject_name, dept_ar: i.dept_ar || '', dept_en: i.dept_en || '', due, late: !!due && due < today, outcome: i.status === 'closed' ? i.outcome : null });
      if (part === 'subject') out.waiting_me = i.status === 'reply' && !i.reply_at;
      if (role.approver) out.waiting_me = i.status === 'decision' || (i.status === 'reply' && i.reply_due < today);
      return out;
    });
    return json({ invs: list, today, role });
  }

  /* open a new investigation (officers) */
  if (method === 'POST' && seg.length === 1) {
    if (!role.officer) fail(403, 'forbidden');
    const body = await readJson(request);
    const data = await readCase(env, body);
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO inv (status, source, title, details, requested_by, subject_user_id, subject_name, subject_emp_no, department_id, opened_by_id, opened_by, minutes_due, created_at, updated_at)
       VALUES ('open', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(data.title, data.details, data.requested_by, data.subject_user_id, data.subject_name, data.subject_emp_no, data.department_id, user.id, user.name, plusWorkdays(today, days.minutes), now, now).run();
    const id = res.meta.last_row_id;
    await env.DB.batch([...peopleStmts(env, id, data), stepStmt(env, id, 'create', user, null), logStmt(env, user, 'create', 'inv', id, '#' + id)]);
    const inv = await getInv(env, id);
    later(notifyInv(env, settings, [...data.committee.map((x) => x.id)].filter((x) => x !== user.id), 'committee', inv, { due: inv.minutes_due }));
    return json({ ok: true, id });
  }

  const id = toId(seg[1]);
  const inv = id ? await getInv(env, id) : null;
  if (!inv) fail(404, 'not_found');
  const { results: people } = await env.DB.prepare('SELECT p.user_id, p.role, u.name, u.name_en FROM inv_people p LEFT JOIN users u ON u.id = p.user_id WHERE p.inv_id = ?').bind(id).all();
  const { results: questions } = await env.DB.prepare('SELECT * FROM inv_questions WHERE inv_id = ? ORDER BY id').bind(id).all();
  const me = people.find((p) => p.user_id === user.id);
  const committee = !!me && (me.role === 'head' || me.role === 'member');
  const isSubject = !!inv.subject_user_id && inv.subject_user_id === user.id;
  const asked = questions.some((q) => q.to_user_id === user.id);
  const runs = role.officer || committee; // can work on the case
  if (!runs && !isSubject && !asked) fail(404, 'not_found');
  const part = role.officer ? 'officer' : committee ? me.role : isSubject ? 'subject' : 'witness';
  const closed = inv.status === 'closed';

  if (method === 'GET' && seg.length === 2) {
    const qOut = (q) => ({
      id: q.id, kind: q.kind, to_user_id: q.to_user_id, to_name: q.to_name, question: q.question, due: q.due, late: !q.answer && q.due < today,
      answer: q.answer || '', answered_at: q.answered_at, answered_by: q.answered_by || '', asked_by: q.asked_by || '', asked_at: q.asked_at,
    });
    const { results: files } = await env.DB.prepare('SELECT id, name, content_type, size, by_id, by_name, created_at FROM inv_files WHERE inv_id = ? ORDER BY id').bind(id).all();
    const mineOnly = (x) => x.by_id === user.id;
    const out = { id: inv.id, status: inv.status, source: inv.source, created_at: inv.created_at, part };
    if (part === 'witness') {
      out.questions = questions.filter((q) => q.to_user_id === user.id).map(qOut);
      out.files = files.filter(mineOnly);
    } else {
      const due = dueOf(inv);
      Object.assign(out, {
        title: inv.title, details: inv.details || '', requested_by: inv.requested_by || '', subject_name: inv.subject_name, subject_emp_no: inv.subject_emp_no || '', subject_user_id: inv.subject_user_id,
        department_id: inv.department_id, dept_ar: inv.dept_ar || '', dept_en: inv.dept_en || '', opened_by: inv.opened_by || '',
        due, late: !!due && due < today, minutes_due: inv.minutes_due, reply_due: inv.reply_due, decision_due: inv.decision_due,
      });
      const showMinutes = part !== 'subject' || inv.status !== 'open';
      if (showMinutes && (inv.minutes_at || part !== 'subject'))
        Object.assign(out, {
          facts: inv.facts || '', finding: inv.finding || '', rec_outcome: inv.rec_outcome || '', rec_penalty_id: inv.rec_penalty_id, rec_pen_ar: inv.rec_pen_ar || '', rec_pen_en: inv.rec_pen_en || '',
          rec_days: inv.rec_days, minutes_at: inv.minutes_at, minutes_by: inv.minutes_by || '',
        });
      Object.assign(out, { reply: inv.reply || '', reply_at: inv.reply_at });
      if (closed) Object.assign(out, { outcome: inv.outcome, penalty_id: inv.penalty_id, pen_ar: inv.pen_ar || '', pen_en: inv.pen_en || '', penalty_days: inv.penalty_days, decision_note: inv.decision_note || '', decided_at: inv.decided_at, decided_by: inv.decided_by || '' });
      if (part === 'subject') {
        out.questions = questions.filter((q) => q.to_user_id === user.id).map(qOut);
        out.files = files.filter(mineOnly);
      } else {
        out.committee = people.filter((p) => p.role === 'head' || p.role === 'member').map((p) => ({ id: p.user_id, role: p.role, name: p.name || '', name_en: p.name_en || '' }));
        out.questions = questions.map(qOut);
        out.files = files;
        out.steps = (await env.DB.prepare('SELECT at, kind, by_name, text FROM inv_steps WHERE inv_id = ? ORDER BY id').bind(id).all()).results;
      }
    }
    // What this person can do now.
    const replyLate = inv.status === 'reply' && inv.reply_due < today;
    out.can = {
      edit: runs && inv.status === 'open',
      ask: runs && inv.status === 'open',
      minutes: runs && inv.status === 'open',
      reply: isSubject && inv.status === 'reply',
      decide: role.approver && (inv.status === 'decision' || replyLate),
      upload: !closed && (runs || isSubject || asked),
      delete: role.manager,
    };
    return json({ inv: out, today, role });
  }

  // Files: GET by anyone who sees the file, POST by anyone taking part while it is open.
  if (seg[2] === 'files') {
    if (method === 'POST' && seg.length === 3) {
      if (closed) fail(409, 'inv_closed');
      const form = await request.formData().catch(() => fail(400, 'bad_request'));
      const file = form.get('file');
      if (!file || typeof file === 'string' || !file.size) fail(400, 'mtg_file_required');
      if (file.size > MAX_FILE_BYTES) fail(413, 'file_too_large');
      const ext = String(file.name || '').split('.').pop().toLowerCase();
      const type = FILE_TYPES[ext];
      if (!type) fail(400, 'mtg_file_type');
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM inv_files WHERE inv_id = ?').bind(id).first();
      if (count.n >= MAX_FILES) fail(409, 'too_many_docs');
      const name = str(form.get('name'), 160) || str(file.name, 160);
      const key = `inv/${id}/${crypto.randomUUID()}.${ext}`;
      await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type } });
      try {
        const res = await env.DB.prepare('INSERT INTO inv_files (inv_id, name, file_key, content_type, size, by_id, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, name, key, type, file.size, user.id, user.name, nowIso()).run();
        await env.DB.batch([stepStmt(env, id, 'file', user, name), touch(env, id), logStmt(env, user, 'create', 'inv_file', res.meta.last_row_id, '#' + id + ' ' + name)]);
        return json({ ok: true, id: res.meta.last_row_id });
      } catch (e) {
        await env.FILES.delete(key);
        throw e;
      }
    }
    const f = seg.length === 4 && toId(seg[3]) ? await env.DB.prepare('SELECT * FROM inv_files WHERE id = ? AND inv_id = ?').bind(toId(seg[3]), id).first() : null;
    if (!f || (!runs && f.by_id !== user.id)) fail(404, 'not_found');
    if (method === 'GET') {
      const obj = await env.FILES.get(f.file_key);
      if (!obj) fail(404, 'not_found');
      const ext = f.file_key.split('.').pop();
      const inline = ['pdf', 'png', 'jpg', 'jpeg'].includes(ext);
      const fname = encodeURIComponent((f.name.toLowerCase().endsWith('.' + ext) ? f.name : f.name + '.' + ext).replace(/[\r\n"]/g, ''));
      return new Response(obj.body, {
        headers: { 'content-type': f.content_type || 'application/octet-stream', 'content-length': String(obj.size), 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${fname}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    if (method === 'DELETE') {
      if (closed) fail(409, 'inv_closed');
      if (!role.officer && f.by_id !== user.id) fail(403, 'forbidden');
      await env.DB.batch([env.DB.prepare('DELETE FROM inv_files WHERE id = ?').bind(f.id), stepStmt(env, id, 'file_delete', user, f.name), logStmt(env, user, 'delete', 'inv_file', f.id, '#' + id + ' ' + f.name)]);
      await env.FILES.delete(f.file_key);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  // POST /inv/<id>/questions/<q>: the person asked answers; for someone without an account, the committee writes it.
  if (method === 'POST' && seg[2] === 'questions' && seg.length === 4) {
    const q = questions.find((x) => String(x.id) === seg[3]);
    if (!q) fail(404, 'not_found');
    if (q.to_user_id ? q.to_user_id !== user.id : !runs) fail(403, 'forbidden');
    if (inv.status !== 'open') fail(409, 'inv_not_open');
    if (q.answer) fail(409, 'inv_answered');
    const answer = str((await readJson(request)).answer, 4000);
    if (!answer) fail(400, 'inv_answer_required');
    await env.DB.batch([
      env.DB.prepare('UPDATE inv_questions SET answer = ?, answered_at = ?, answered_by = ? WHERE id = ?').bind(answer, nowIso(), user.name, q.id),
      stepStmt(env, id, q.to_user_id ? 'answer' : 'answer_recorded', user, q.to_name),
      touch(env, id),
      logStmt(env, user, 'answer', 'inv', id, '#' + id),
    ]);
    // Once the person has answered everything asked, the committee is told.
    if (q.to_user_id && !questions.some((x) => x.id !== q.id && x.to_user_id === q.to_user_id && !x.answer)) {
      const to = people.filter((p) => p.role === 'head' || p.role === 'member').map((p) => p.user_id);
      later(notifyInv(env, settings, to.length ? to : [q.asked_by_id], 'answered', inv));
    }
    return json({ ok: true });
  }

  // POST /inv/<id>/reply {reply}: the person investigated replies to the minutes.
  if (method === 'POST' && seg[2] === 'reply' && seg.length === 3) {
    if (!isSubject) fail(403, 'forbidden');
    if (inv.status !== 'reply') fail(409, 'inv_not_reply');
    const reply = str((await readJson(request)).reply, 4000);
    if (!reply) fail(400, 'inv_reply_required');
    const now = nowIso();
    const due = plusWorkdays(today, days.decision);
    await env.DB.batch([
      env.DB.prepare("UPDATE inv SET status = 'decision', reply = ?, reply_at = ?, decision_due = ?, updated_at = ? WHERE id = ?").bind(reply, now, due, now, id),
      stepStmt(env, id, 'reply', user, null),
      logStmt(env, user, 'reply', 'inv', id, '#' + id),
    ]);
    const fresh = await getInv(env, id);
    later(notifyInv(env, settings, [...(await approverIds(env, settings)), ...people.filter((p) => p.role === 'head').map((p) => p.user_id)], 'decision', fresh, { due }));
    return json({ ok: true });
  }

  // POST /inv/<id>/decide {outcome, penalty_id, days, note}: the approver closes it with the decision.
  // Without the person's reply, only once the reply's deadline has passed.
  if (method === 'POST' && seg[2] === 'decide' && seg.length === 3) {
    if (!role.approver) fail(403, 'forbidden');
    if (!(inv.status === 'decision' || (inv.status === 'reply' && inv.reply_due < today))) fail(409, 'inv_not_decision');
    const body = await readJson(request);
    const d = await readOutcome(env, body);
    const note = str(body.note, 3000);
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE inv SET status = 'closed', outcome = ?, penalty_id = ?, penalty_days = ?, decision_note = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?")
        .bind(d.outcome, d.penalty_id, d.days, note || null, now, user.name, now, id),
      stepStmt(env, id, 'decide', user, note),
      logStmt(env, user, 'decide', 'inv', id, '#' + id, { outcome: [null, d.outcome], penalty_id: [null, d.penalty_id], penalty_days: [null, d.days] }),
    ]);
    const fresh = await getInv(env, id);
    later(notifyInv(env, settings, [inv.subject_user_id, inv.opened_by_id, ...people.filter((p) => p.role === 'head' || p.role === 'member').map((p) => p.user_id)].filter((x) => x && x !== user.id), 'closed', fresh));
    return json({ ok: true });
  }

  // POST /inv/<id>/return {note}: the approver sends the minutes back to the committee.
  if (method === 'POST' && seg[2] === 'return' && seg.length === 3) {
    if (!role.approver) fail(403, 'forbidden');
    if (inv.status !== 'decision' && inv.status !== 'reply') fail(409, 'inv_not_decision');
    const note = str((await readJson(request)).note, 2000);
    if (!note) fail(400, 'ovr_note_required');
    const due = plusWorkdays(today, days.minutes);
    await env.DB.batch([
      env.DB.prepare("UPDATE inv SET status = 'open', minutes_at = NULL, minutes_due = ?, reply_due = NULL, decision_due = NULL, updated_at = ? WHERE id = ?").bind(due, nowIso(), id),
      stepStmt(env, id, 'return', user, note),
      logStmt(env, user, 'return', 'inv', id, '#' + id),
    ]);
    const to = people.filter((p) => p.role === 'head' || p.role === 'member').map((p) => p.user_id);
    later(notifyInv(env, settings, to.length ? to : [inv.opened_by_id], 'returned', { ...inv, status: 'open' }, { due }));
    return json({ ok: true });
  }

  if (!runs) fail(403, 'forbidden');

  // PUT /inv/<id>: the case itself and the committee, while it is open.
  if (method === 'PUT' && seg.length === 2) {
    if (inv.status !== 'open') fail(409, 'inv_not_open');
    if (!role.officer) fail(403, 'forbidden');
    const data = await readCase(env, await readJson(request));
    const before = people.filter((p) => p.role === 'head' || p.role === 'member').map((p) => p.user_id);
    await env.DB.batch([
      env.DB.prepare('UPDATE inv SET title = ?, details = ?, requested_by = ?, subject_user_id = ?, subject_name = ?, subject_emp_no = ?, department_id = ?, updated_at = ? WHERE id = ?')
        .bind(data.title, data.details, data.requested_by, data.subject_user_id, data.subject_name, data.subject_emp_no, data.department_id, nowIso(), id),
      env.DB.prepare('DELETE FROM inv_people WHERE inv_id = ?').bind(id),
      ...peopleStmts(env, id, data),
      stepStmt(env, id, 'edit', user, null),
      logStmt(env, user, 'update', 'inv', id, '#' + id, changes(inv, data, ['title', 'subject_name', 'subject_user_id', 'department_id'])),
    ]);
    const added = data.committee.map((x) => x.id).filter((x) => !before.includes(x) && x !== user.id);
    if (added.length) later(notifyInv(env, settings, added, 'committee', inv, { due: inv.minutes_due }));
    return json({ ok: true });
  }

  // POST /inv/<id>/questions {to: 'subject' | user id | '', to_name, questions: [..]}: questions to one person.
  if (method === 'POST' && seg[2] === 'questions' && seg.length === 3) {
    if (inv.status !== 'open') fail(409, 'inv_not_open');
    const body = await readJson(request);
    const list = (Array.isArray(body.questions) ? body.questions : [body.question]).map((x) => str(x, 2000)).filter(Boolean).slice(0, MAX_QUESTIONS);
    if (!list.length) fail(400, 'inv_question_required');
    let to;
    if (body.to === 'subject') to = { kind: 'subject', id: inv.subject_user_id || null, name: inv.subject_name };
    else if (toId(body.to)) {
      const [p] = await activeUsers(env, [body.to]);
      if (!p) fail(400, 'inv_bad_person');
      to = { kind: p.id === inv.subject_user_id ? 'subject' : 'witness', id: p.id, name: p.name };
    } else {
      const name = str(body.to_name, 120);
      if (!name) fail(400, 'inv_bad_person');
      to = { kind: 'witness', id: null, name };
    }
    const due = plusWorkdays(today, days.answer);
    const now = nowIso();
    await env.DB.batch([
      ...list.map((q) =>
        env.DB.prepare('INSERT INTO inv_questions (inv_id, kind, to_user_id, to_name, question, due, asked_by_id, asked_by, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, to.kind, to.id, to.name, q, due, user.id, user.name, now),
      ),
      stepStmt(env, id, 'ask', user, to.name),
      touch(env, id),
      logStmt(env, user, 'ask', 'inv', id, '#' + id, { to: [null, to.name], n: [null, list.length] }),
    ]);
    if (to.id) later(notifyInv(env, settings, [to.id], 'question', inv, { due }));
    return json({ ok: true, due });
  }

  // DELETE /inv/<id>/questions/<q>: take back a question not answered yet.
  if (method === 'DELETE' && seg[2] === 'questions' && seg.length === 4) {
    const q = questions.find((x) => String(x.id) === seg[3]);
    if (!q) fail(404, 'not_found');
    if (q.answer) fail(409, 'inv_answered');
    if (inv.status !== 'open') fail(409, 'inv_not_open');
    await env.DB.batch([env.DB.prepare('DELETE FROM inv_questions WHERE id = ?').bind(q.id), stepStmt(env, id, 'unask', user, q.to_name), logStmt(env, user, 'unask', 'inv', id, '#' + id)]);
    return json({ ok: true });
  }

  // PUT /inv/<id>/minutes {facts, finding, rec_outcome, rec_penalty_id, rec_days, submit}: the committee's minutes.
  // Submitted: to the person for their reply (with an account), or straight to the decision.
  if (method === 'PUT' && seg[2] === 'minutes' && seg.length === 3) {
    if (inv.status !== 'open') fail(409, 'inv_not_open');
    const body = await readJson(request);
    const facts = str(body.facts, 8000);
    const finding = str(body.finding, 4000);
    const rec = body.rec_outcome ? await readOutcome(env, { outcome: body.rec_outcome, penalty_id: body.rec_penalty_id, days: body.rec_days }) : { outcome: null, penalty_id: null, days: null };
    const submit = !!body.submit;
    if (submit) {
      if (!facts || !finding) fail(400, 'inv_minutes_required');
      if (!rec.outcome) fail(400, 'inv_bad_outcome');
      // Questions still within their time hold the minutes back; past it, "no answer" stays on record.
      if (questions.some((q) => !q.answer && q.due >= today)) fail(409, 'inv_questions_open');
    }
    const now = nowIso();
    const toReply = submit && !!inv.subject_user_id;
    const status = !submit ? 'open' : toReply ? 'reply' : 'decision';
    const replyDue = toReply ? plusWorkdays(today, days.answer) : null;
    const decisionDue = submit && !toReply ? plusWorkdays(today, days.decision) : null;
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE inv SET facts = ?, finding = ?, rec_outcome = ?, rec_penalty_id = ?, rec_days = ?, status = ?, minutes_at = ?, minutes_by = ?, reply_due = ?, decision_due = ?, reply = NULL, reply_at = NULL, updated_at = ? WHERE id = ?',
      ).bind(facts || null, finding || null, rec.outcome, rec.penalty_id, rec.days, status, submit ? now : null, user.name, replyDue, decisionDue, now, id),
      ...(submit ? [stepStmt(env, id, 'minutes', user, null), logStmt(env, user, 'minutes', 'inv', id, '#' + id)] : []),
    ]);
    if (submit) {
      const fresh = await getInv(env, id);
      if (toReply) later(notifyInv(env, settings, [inv.subject_user_id], 'minutes', fresh, { due: replyDue }));
      else later((async () => notifyInv(env, settings, await approverIds(env, settings), 'decision', fresh, { due: decisionDue }))());
    }
    return json({ ok: true, status });
  }

  // DELETE /inv/<id>: a manager removes one opened by mistake.
  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    const { results: files } = await env.DB.prepare('SELECT file_key FROM inv_files WHERE inv_id = ?').bind(id).all();
    await env.DB.batch([
      ...['inv_questions', 'inv_files', 'inv_steps', 'inv_people'].map((tb) => env.DB.prepare(`DELETE FROM ${tb} WHERE inv_id = ?`).bind(id)),
      env.DB.prepare('DELETE FROM inv WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'inv', id, '#' + id),
    ]);
    if (files.length) await env.FILES.delete(files.map((f) => f.file_key));
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

// The case: title, details, who asked for it, the person (an account, or a name and number) and the committee.
async function readCase(env, body) {
  const title = str(body.title, 200);
  if (!title) fail(400, 'inv_title_required');
  let subjectUser = null;
  let subjectName = str(body.subject_name, 120);
  const subjectEmp = str(body.subject_emp_no, 30).replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x660));
  let dept = toId(body.department_id);
  if (toId(body.subject_user_id)) {
    const u = await env.DB.prepare('SELECT id, name, department_id FROM users WHERE id = ? AND active = 1').bind(toId(body.subject_user_id)).first();
    if (!u) fail(400, 'inv_bad_person');
    subjectUser = u.id;
    subjectName = u.name;
    if (!dept) dept = u.department_id || null;
  }
  if (!subjectName) fail(400, 'inv_subject_required');
  if (dept && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(dept).first())) dept = null;
  const headId = toId(body.head_id);
  const memberIds = (Array.isArray(body.members) ? body.members : []).map(toId).filter((x) => x && x !== headId);
  const found = await activeUsers(env, [headId, ...memberIds]);
  if (found.some((x) => x.id === subjectUser)) fail(400, 'inv_subject_in_committee');
  const committee = found.map((x) => ({ id: x.id, role: x.id === headId ? 'head' : 'member' }));
  return {
    title, details: str(body.details, 4000) || null, requested_by: str(body.requested_by, 200) || null,
    subject_user_id: subjectUser, subject_name: subjectName, subject_emp_no: subjectEmp || null, department_id: dept, committee,
  };
}

const peopleStmts = (env, id, data) => [
  ...data.committee.map((x) => env.DB.prepare('INSERT INTO inv_people (inv_id, user_id, role) VALUES (?, ?, ?)').bind(id, x.id, x.role)),
  ...(data.subject_user_id ? [env.DB.prepare("INSERT INTO inv_people (inv_id, user_id, role) VALUES (?, ?, 'subject') ON CONFLICT DO NOTHING").bind(id, data.subject_user_id)] : []),
];

// cleared (no violation proved), or a penalty from the list (with its days when it takes them).
async function readOutcome(env, body) {
  const outcome = INV_OUTCOMES.includes(body.outcome) ? body.outcome : null;
  if (!outcome) fail(400, 'inv_bad_outcome');
  if (outcome === 'cleared') return { outcome, penalty_id: null, days: null };
  const p = toId(body.penalty_id) ? await env.DB.prepare('SELECT id, days FROM inv_penalties WHERE id = ? AND active = 1').bind(toId(body.penalty_id)).first() : null;
  if (!p) fail(400, 'inv_bad_penalty');
  let d = null;
  if (p.days) {
    d = Number(body.days);
    if (!Number.isInteger(d) || d < 1 || d > 365) fail(400, 'inv_bad_penalty_days');
  }
  return { outcome, penalty_id: p.id, days: d };
}

/* ------------------------------ committee absence -------------------------- */

// When minutes are approved: a member absent without excuse this many sessions in a row (ovr_absence_after) gets an
// investigation, with a question to them about the reason (in the system when they have an account; otherwise the
// committee writes what they say). One per member and session.
export async function absenceInvestigations(env, c, s, code) {
  const settings = await getSettings(env);
  const after = Number(settings.ovr_absence_after) || 0;
  if (!after) return [];
  const { results: absent } = await env.DB.prepare(
    "SELECT m.id, m.name, m.emp_no, m.email FROM session_attendance a JOIN committee_members m ON m.id = a.member_id WHERE a.session_id = ? AND a.status = 'absent'",
  ).bind(s.id).all();
  if (!absent.length) return [];
  const today = todayIn(settings.timezone);
  const days = daysOf(settings);
  const made = [];
  for (const m of absent) {
    const ref = `absence:${s.id}:${m.id}`;
    if (await env.DB.prepare('SELECT 1 AS x FROM inv WHERE ref = ?').bind(ref).first()) continue;
    // Unexcused absences in a row, this session included, over the committee's approved minutes.
    const { results: past } = await env.DB.prepare(
      `SELECT a.status FROM session_attendance a JOIN committee_sessions x ON x.id = a.session_id
        WHERE x.committee_id = ? AND a.member_id = ? AND x.minutes_status = 'approved' AND (x.date < ? OR (x.date = ? AND x.start_time <= ?))
        ORDER BY x.date DESC, x.start_time DESC LIMIT 50`,
    ).bind(c.id, m.id, s.date, s.date, s.start_time).all();
    let n = 0;
    while (n < past.length && past[n].status === 'absent') n++;
    if (n < after) continue;
    const [staff, account] = await Promise.all([
      m.emp_no ? env.DB.prepare('SELECT department_id FROM staff WHERE emp_no = ?').bind(m.emp_no).first() : null,
      m.email ? env.DB.prepare('SELECT id, name, department_id FROM users WHERE lower(email) = lower(?) AND active = 1').bind(m.email).first() : null,
    ]);
    const dept = (account && account.department_id) || (staff && staff.department_id) || c.department_id || null;
    const now = nowIso();
    const res = await env.DB.prepare(
      `INSERT INTO inv (status, source, ref, title, details, requested_by, subject_user_id, subject_name, subject_emp_no, department_id, opened_by, minutes_due, created_at, updated_at)
       VALUES ('open', 'absence', ?, ?, ?, ?, ?, ?, ?, ?, 'النظام | System', ?, ?, ?)`,
    ).bind(
      ref, 'غياب عن اجتماع لجنة | Committee absence',
      `غياب بدون عذر عن ${c.name_ar} (${code}) بتاريخ ${s.date}، ${n} مرات متتالية.\nUnexcused absence from ${c.name_en} (${code}) on ${s.date}, ${n} in a row.`,
      `${c.name_ar} (${code})`, account ? account.id : null, account ? account.name : m.name, m.emp_no || null, dept, plusWorkdays(today, days.minutes), now, now,
    ).run();
    const id = res.meta.last_row_id;
    const due = plusWorkdays(today, days.answer);
    await env.DB.batch([
      ...(account ? [env.DB.prepare("INSERT INTO inv_people (inv_id, user_id, role) VALUES (?, ?, 'subject') ON CONFLICT DO NOTHING").bind(id, account.id)] : []),
      env.DB.prepare("INSERT INTO inv_questions (inv_id, kind, to_user_id, to_name, question, due, asked_by, asked_at) VALUES (?, 'subject', ?, ?, ?, ?, 'النظام | System', ?)").bind(
        id, account ? account.id : null, account ? account.name : m.name,
        `ما سبب غيابك بدون عذر عن ${c.name_ar} بتاريخ ${s.date}؟\nWhy were you absent without excuse from ${c.name_en} on ${s.date}?`, due, now,
      ),
      stepStmt(env, id, 'create', null, null),
      logStmt(env, null, 'create', 'inv', id, '#' + id),
    ]);
    const inv = await getInv(env, id);
    await notifyInv(env, settings, await officerIds(env, settings), 'new', inv, { due: inv.minutes_due });
    if (account) await notifyInv(env, settings, [account.id], 'question', inv, { due });
    made.push(id);
  }
  return made;
}

/* ---------------------------------- home ----------------------------------- */

export async function invHome(env, user, today) {
  const settings = await getSettings(env);
  const role = invRole(user, settings);
  if (role.officer) {
    const r = await env.DB.prepare(
      `SELECT COALESCE(SUM(status <> 'closed'), 0) AS open,
              COALESCE(SUM((status = 'open' AND minutes_due < ?1) OR (status = 'reply' AND reply_due < ?1) OR (status = 'decision' AND decision_due < ?1)), 0) AS late,
              COALESCE(SUM(status = 'decision' OR (status = 'reply' AND reply_due < ?1)), 0) AS decision FROM inv`,
    ).bind(today).first();
    return { open: r.open, late: r.late, decision: r.decision };
  }
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM inv_questions q JOIN inv i ON i.id = q.inv_id WHERE q.to_user_id = ?1 AND q.answer IS NULL AND i.status = 'open') AS questions,
            (SELECT COUNT(*) FROM inv WHERE subject_user_id = ?1 AND status = 'reply') AS reply,
            (SELECT COUNT(*) FROM inv i JOIN inv_people p ON p.inv_id = i.id AND p.user_id = ?1 AND p.role IN ('head', 'member') WHERE i.status = 'open') AS committee`,
  ).bind(user.id).first();
  if (!r.questions && !r.reply && !r.committee && (await invAccess(env, user, settings)) === 'none') return null;
  return { questions: r.questions, reply: r.reply, committee: r.committee };
}

/* ------------------------------ daily reminders ----------------------------- */

// Every morning: unanswered questions past their date are reminded to their person once a day; an investigation past
// its stage's date reminds whoever holds it (the committee, the person, the approver), and the officers once late.
export async function runInvReminders(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results: qs } = await env.DB.prepare(
    `SELECT q.id, q.inv_id, q.to_user_id, q.due FROM inv_questions q JOIN inv i ON i.id = q.inv_id
      WHERE q.answer IS NULL AND q.to_user_id IS NOT NULL AND i.status = 'open' AND q.due < ? AND (q.reminded_on IS NULL OR q.reminded_on < ?) ORDER BY q.due LIMIT 20`,
  ).bind(today, today).all();
  const sentTo = new Set();
  for (const q of qs) {
    const key = q.inv_id + ':' + q.to_user_id;
    if (sentTo.has(key)) continue;
    sentTo.add(key);
    await notifyInv(env, settings, [q.to_user_id], 'late_q', await getInv(env, q.inv_id), { due: q.due });
  }
  if (qs.length) await env.DB.prepare(`UPDATE inv_questions SET reminded_on = ? WHERE id IN (${qs.map((q) => q.id).join(',')})`).bind(today).run();

  const { results: late } = await env.DB.prepare(
    `${SELECT} WHERE i.status <> 'closed' AND (i.reminded_on IS NULL OR i.reminded_on < ?1)
       AND ((i.status = 'open' AND i.minutes_due < ?1) OR (i.status = 'reply' AND i.reply_due < ?1) OR (i.status = 'decision' AND i.decision_due < ?1)) ORDER BY i.id LIMIT 10`,
  ).bind(today).all();
  for (const i of late) {
    let to;
    if (i.status === 'open') {
      const { results } = await env.DB.prepare("SELECT user_id FROM inv_people WHERE inv_id = ? AND role IN ('head', 'member')").bind(i.id).all();
      to = [...results.map((r) => r.user_id), ...(await officerIds(env, settings))];
    } else to = await approverIds(env, settings); // a late reply: the approver can decide now
    await notifyInv(env, settings, to, 'late', i, { due: dueOf(i) });
    await env.DB.prepare('UPDATE inv SET reminded_on = ? WHERE id = ?').bind(today, i.id).run();
  }
  return { questions: sentTo.size, late: late.length };
}

// Requests and work orders: tickets, the public request form, alerts, staff list and the AI suggestion.
import { readJson, requireRole } from '../lib/auth.js';
import { ADMIN_ROLES, appName, logoType } from '../lib/config.js';
import { changes, getSettings, logStmt, membersFromStaffStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { PUSH_PER_EVENT, deliverPush, pushSubsOf, sendPush, ticketPush } from '../lib/push.js';
import { checkLang, escHtml, fail, json, nowIso, sha256Hex, str, toHex, todayIn } from '../lib/util.js';
import { pmClosedStmts } from './assets.js';
import { assetContract, num, vendorLate } from './contracts.js';

/* -------------------------------- tickets -------------------------------- */

// Maintenance requests. Employees send them from a public page (no account), technicians and
// engineers of the receiving team take and close them, and late ones are emailed to the team,
// then to the super admins.
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const RESOLUTIONS = ['resolved', 'workaround', 'unresolved'];
// Why a ticket was closed without a lasting fix, and why work is on hold. Named in public/i18n.js.
export const CLOSE_CODES = ['replace', 'vendor', 'duplicate', 'no_fault', 'not_ours', 'other'];
export const HOLD_CODES = ['parts', 'vendor', 'access', 'requester', 'other'];
export const REOPEN_DAYS = 3; // the employee can rate or reopen a closed ticket for this long
export const PUBLIC_PER_HOUR = 20; // requests per device address and hour
export const STAFF_PER_HOUR = 6; // tickets per employee number and hour
export const SUGGEST_PER_HOUR = 30; // AI suggestions per device address and hour
export const LOOKUPS_PER_HOUR = 30; // employee number look-ups per device address and hour
export const REPEAT_DAYS = 30; // the same problem from the same place this often...
export const REPEAT_MIN = 3; // ...this many times is flagged as a repeated fault
export const LOW_RATING = 2; // a rating this low or lower alerts the supervisors
export const MAX_STAFF_ROWS = 2000; // per import request
export const ALERTS_PER_RUN = 15; // the free plan allows 50 database queries per run
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const addMinutes = (iso, min) => new Date(Date.parse(iso) + min * 60000).toISOString();
export const shiftIso = (iso, ms) => (iso ? new Date(Date.parse(iso) + ms).toISOString() : iso);
export const slaFor = (s, p) => ({ resp: s[`sla_p${p}_resp`], res: s[`sla_p${p}_res`] });
// "Affects a patient now" (the word comes from the settings: patient, student, guest...) raises the category's priority one step (1 = critical ... 4 = low).
export const ticketPriority = (catPriority, impact) => Math.max(1, Math.min(4, catPriority) - (impact ? 1 : 0));
export const toInt = (v) => (Number.isInteger(Number(v)) && v !== '' && v !== null ? Number(v) : null);

export function isoTime(v) {
  const s = str(v, 40);
  const t = Date.parse(s);
  if (!s || Number.isNaN(t)) fail(400, 'invalid_time');
  return new Date(t).toISOString();
}

// Late = past the time to receive (new) or past the expected / target time (in progress).
export function ticketLate(t, now) {
  if (t.status === 'new') return now > t.response_due ? 'response' : null;
  if (t.status === 'in_progress') return now > (t.expected_at || t.resolve_due) ? 'resolve' : null;
  return null;
}

export const TICKET_SELECT = `SELECT t.*, c.name_ar AS cat_ar, c.name_en AS cat_en, tm.name_ar AS team_ar, tm.name_en AS team_en,
       rd.name_ar AS rdept_ar, rd.name_en AS rdept_en, u.name AS assignee_name, u.name_en AS assignee_name_en, u.job_title AS assignee_title, u.email AS assignee_email, u.active AS assignee_active,
       l.name_ar AS loc_ar, l.name_en AS loc_en, a.name_ar AS asset_ar, a.name_en AS asset_en, p.kind AS pm_kind,
       vd.name_ar AS vendor_ar, vd.name_en AS vendor_en, vd.phone AS vendor_phone, ct.number AS contract_number, ct.response_hours, ct.penalty_per_hour,
       sf.name_en AS requester_name_en
  FROM tickets t
  LEFT JOIN ticket_categories c ON c.id = t.category_id
  LEFT JOIN departments tm ON tm.id = t.team_id
  LEFT JOIN departments rd ON rd.id = t.requester_dept_id
  LEFT JOIN users u ON u.id = t.assigned_to
  LEFT JOIN locations l ON l.id = t.location_id
  LEFT JOIN assets a ON a.id = t.asset_id
  LEFT JOIN pm_plans p ON p.id = t.pm_plan_id
  LEFT JOIN vendors vd ON vd.id = t.vendor_id
  LEFT JOIN contracts ct ON ct.id = t.contract_id
  LEFT JOIN staff sf ON sf.id = t.staff_id`;

export function ticketOut(t, now) {
  return {
    id: t.id,
    status: t.status,
    priority: t.priority,
    patient_impact: !!t.patient_impact,
    category_id: t.category_id,
    cat_ar: t.cat_ar || '',
    cat_en: t.cat_en || '',
    team_id: t.team_id,
    team_ar: t.team_ar || '',
    team_en: t.team_en || '',
    requester_emp_no: t.requester_emp_no,
    requester_name: t.requester_name,
    requester_name_en: t.requester_name_en || t.requester_name,
    requester_dept_id: t.requester_dept_id,
    rdept_ar: t.rdept_ar || '',
    rdept_en: t.rdept_en || '',
    requester_phone: t.requester_phone || '',
    location_id: t.location_id,
    loc_ar: t.loc_ar || '',
    loc_en: t.loc_en || '',
    location_text: t.location_text || '',
    asset_tag: t.asset_tag || '',
    asset_id: t.asset_id || null,
    asset_ar: t.asset_ar || '',
    asset_en: t.asset_en || '',
    pm_plan_id: t.pm_plan_id || null,
    pm_kind: t.pm_plan_id ? t.pm_kind || 'ppm' : null,
    pm_due: t.pm_due || null,
    description: t.description,
    has_photo: !!t.photo_key,
    assigned_to: t.assigned_to,
    assignee_name: t.assignee_name || '',
    assignee_name_en: t.assignee_name_en || t.assignee_name || '',
    assignee_title: t.assignee_title || '',
    received_at: t.received_at,
    expected_at: t.expected_at,
    response_due: t.response_due,
    resolve_due: t.resolve_due,
    hold_since: t.hold_since,
    hold_reason: t.hold_reason,
    closed_at: t.closed_at,
    resolution: t.resolution,
    close_code: t.close_code,
    close_note: t.close_note,
    cause_note: t.cause_note,
    rating: t.rating,
    rating_note: t.rating_note,
    reopen_count: t.reopen_count,
    repeat_n: t.repeat_n || 0,
    created_at: t.created_at,
    updated_at: t.updated_at,
    late: ticketLate(t, now),
    vendor_id: t.vendor_id || null,
    vendor_ar: t.vendor_ar || '',
    vendor_en: t.vendor_en || '',
    vendor_phone: t.vendor_phone || '',
    contract_id: t.contract_id || null,
    contract_number: t.contract_number || '',
    vendor_called_at: t.vendor_called_at || null,
    vendor_arrived_at: t.vendor_arrived_at || null,
    vendor: t.vendor_called_at ? vendorLate(t, t.contract_id ? { response_hours: t.response_hours, penalty_per_hour: t.penalty_per_hour } : null, now) : null,
    response_met: t.received_at ? t.received_at <= t.response_due : null,
    sla_met: t.closed_at ? t.closed_at <= t.resolve_due : null,
  };
}

// Technicians and the department admin of a team work on its tickets; that admin is its supervisor.
// The admin of any other department sees (only) the tickets its own staff sent.
// Service Desk roles (user.desk): admin, supervisor and technician work in a team; dept follows its own department's requests.
export const inTeam = (user, teamId) => (user.desk === 'technician' || user.desk === 'supervisor') && user.department_id === teamId;
export const canWorkTicket = (user, t) => user.desk === 'admin' || inTeam(user, t.team_id);
export const canSuperviseTicket = (user, t) => user.desk === 'admin' || (user.desk === 'supervisor' && user.department_id === t.team_id);
export const canSeeTicket = (user, t) => canWorkTicket(user, t) || ((user.desk === 'dept' || user.desk === 'supervisor') && user.department_id === t.requester_dept_id);

export const eventStmt = (env, ticketId, user, kind, note, data) =>
  env.DB.prepare('INSERT INTO ticket_events (ticket_id, at, user_id, actor, kind, note, data) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
    ticketId,
    nowIso(),
    user ? user.id || null : null,
    user ? user.name : 'system',
    kind,
    note || null,
    data && Object.keys(data).length ? JSON.stringify(data) : null,
  );

export async function hashIp(request) {
  return sha256Hex('fm-ip:' + (request.headers.get('CF-Connecting-IP') || 'local'));
}

// Photos are recognised by their bytes, like the logo; SVG is not accepted here.
export function photoType(bytes) {
  const type = logoType(bytes);
  return type === 'image/svg+xml' ? null : type;
}

export const TICKET_MAIL = {
  ar: {
    subject: {
      new: (t) => `بلاغ جديد #${t.id}: ${t.cat_ar}`,
      transferred: (t) => `بلاغ محال إلى فريقك #${t.id}: ${t.cat_ar}`,
      assigned: (t) => `أُحيل البلاغ #${t.id} إليك`,
      reopened: (t) => `أعاد الموظف فتح البلاغ #${t.id}`,
      late_response: (t) => `لم يُستلم البلاغ #${t.id} في وقته`,
      late_resolve: (t) => `تأخر حل البلاغ #${t.id}`,
      escalate: (t) => `تصعيد: البلاغ #${t.id} متأخر`,
      repeat: (t) => `عطل متكرر: ${t.cat_ar} (${t.repeat_n} بلاغات خلال ${REPEAT_DAYS} يومًا)`,
      low_rating: (t) => `تقييم منخفض للبلاغ #${t.id}: ${t.rating} من 5`,
    },
    intro: {
      new: 'ورد بلاغ جديد إلى فريقك:',
      transferred: 'أُحيل هذا البلاغ إلى فريقك:',
      assigned: 'أُحيل هذا البلاغ إليك:',
      reopened: 'أعاد الموظف فتح البلاغ لأن المشكلة لم تُحل:',
      late_response: 'لم يُستلم هذا البلاغ حتى الآن، وتجاوز وقت الاستلام المحدد:',
      late_resolve: 'هذا البلاغ تجاوز الوقت المتوقع للحل:',
      escalate: 'هذا البلاغ متأخر بأكثر من ضعف الوقت المحدد:',
      repeat: (t) => `ورد هذا العطل ${t.repeat_n} مرات من الموقع أو الجهاز نفسه خلال ${REPEAT_DAYS} يومًا، وقد يحتاج إلى معالجة جذرية:`,
      low_rating: (t) => `قيّم مقدّم البلاغ الخدمة بـ ${t.rating} من 5${t.rating_note ? `: "${t.rating_note}"` : '.'}`,
    },
    labels: { category: 'نوع العطل', team: 'الفريق', priority: 'الأولوية', requester: 'مقدّم البلاغ', location: 'المكان', asset: 'رقم الجهاز', description: 'الوصف', due: 'الوقت المطلوب', assignee: 'المسؤول' },
    priority: ['', 'حرجة', 'عالية', 'عادية', 'منخفضة'],
    impact: (s) => `يؤثر على ${s.who_one_ar} حاليًا`,
    open: 'فتح البلاغ',
    footer: (app) => `رسالة تلقائية من نظام البلاغات - ${app}.`,
    locale: 'ar-EG-u-nu-latn',
    dir: 'rtl',
  },
  en: {
    subject: {
      new: (t) => `New request #${t.id}: ${t.cat_en}`,
      transferred: (t) => `Request #${t.id} moved to your team: ${t.cat_en}`,
      assigned: (t) => `Request #${t.id} was assigned to you`,
      reopened: (t) => `Request #${t.id} was reopened`,
      late_response: (t) => `Request #${t.id} was not received in time`,
      late_resolve: (t) => `Request #${t.id} is overdue`,
      escalate: (t) => `Escalation: request #${t.id} is overdue`,
      repeat: (t) => `Repeated fault: ${t.cat_en} (${t.repeat_n} requests in ${REPEAT_DAYS} days)`,
      low_rating: (t) => `Low rating for request #${t.id}: ${t.rating} of 5`,
    },
    intro: {
      new: 'A new request came in for your team:',
      transferred: 'This request was moved to your team:',
      assigned: 'This request was assigned to you:',
      reopened: 'The employee reopened this request because the problem is still there:',
      late_response: 'Nobody has received this request yet and the time to receive it has passed:',
      late_resolve: 'This request has passed its expected resolution time:',
      escalate: 'This request is late by more than twice its allowed time:',
      repeat: (t) => `This fault came ${t.repeat_n} times from the same place or device in ${REPEAT_DAYS} days and may need a lasting fix:`,
      low_rating: (t) => `The requester rated the service ${t.rating} of 5${t.rating_note ? `: "${t.rating_note}"` : '.'}`,
    },
    labels: { category: 'Problem type', team: 'Team', priority: 'Priority', requester: 'Requested by', location: 'Location', asset: 'Device no.', description: 'Description', due: 'Due', assignee: 'Assigned to' },
    priority: ['', 'Critical', 'High', 'Normal', 'Low'],
    impact: (s) => `Affects ${s.who_one_en} now`,
    open: 'Open the request',
    footer: (app) => `Automatic message from the requests system - ${app}.`,
    locale: 'en-GB',
    dir: 'ltr',
  },
};

export function ticketMail(settings, kind, t) {
  const lang = settings.email_lang === 'en' ? 'en' : 'ar';
  const L = TICKET_MAIL[lang];
  const app = appName(settings, lang);
  const align = L.dir === 'rtl' ? 'right' : 'left';
  const pick = (ar, en) => (lang === 'en' ? en || ar : ar || en);
  let when = '';
  const due = t.status === 'new' ? t.response_due : t.expected_at || t.resolve_due;
  try {
    when = new Intl.DateTimeFormat(L.locale, { timeZone: settings.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(due));
  } catch {
    when = due;
  }
  const rows = [
    [L.labels.category, pick(t.cat_ar, t.cat_en)],
    [L.labels.team, pick(t.team_ar, t.team_en)],
    [L.labels.priority, L.priority[t.priority] + (t.patient_impact ? ' - ' + L.impact(settings) : '')],
    [L.labels.requester, `${t.requester_name} (${t.requester_emp_no})${t.rdept_ar || t.rdept_en ? ' - ' + pick(t.rdept_ar, t.rdept_en) : ''}${t.requester_phone ? ' - ' + t.requester_phone : ''}`],
    [L.labels.location, [pick(t.loc_ar, t.loc_en), t.location_text].filter(Boolean).join(' - ')],
    [L.labels.asset, t.asset_tag],
    [L.labels.assignee, lang === 'en' ? t.assignee_name_en || t.assignee_name : t.assignee_name],
    [L.labels.due, when],
    [L.labels.description, t.description],
  ].filter(([, v]) => v);
  const cell = `padding:7px 10px;border-bottom:1px solid #f1eadb;text-align:${align};font-size:14px;vertical-align:top`;
  const table = rows.map(([k, v]) => `<tr><th style="${cell};background:#faf7f0;width:30%;white-space:nowrap">${escHtml(k)}</th><td style="${cell};white-space:pre-wrap">${escHtml(v)}</td></tr>`).join('');
  const link = settings.site_url ? `<p style="margin:18px 0"><a href="${escHtml(settings.site_url + '/#/desk/tickets/' + t.id)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)} #${t.id}</a></p>` : '';
  const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(settings)}<p style="font-size:15px">${escHtml(typeof L.intro[kind] === 'function' ? L.intro[kind](t) : L.intro[kind])}</p><table style="border-collapse:collapse;width:100%">${table}</table>${link}<p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
  return { subject: `${L.subject[kind](t)} - ${app}`, html };
}

export async function ticketPeople(env, teamId) {
  const { results } = await env.DB.prepare("SELECT id, email, desk_role FROM users WHERE active = 1 AND department_id = ? AND role NOT IN ('super_admin', 'systems_admin') AND desk_role IN ('supervisor', 'technician')").bind(teamId).all();
  return { supervisors: results.filter((u) => u.desk_role === 'supervisor'), techs: results.filter((u) => u.desk_role === 'technician') };
}
export const emailsOf = (list) => [...new Set(list.filter(Boolean).map((u) => u.email))];

// Who hears about what: a new request goes to the team supervisors (to the technicians when the team
// has none), a critical one to the whole team; an assignment to the technician; a reopen to both.
export async function notifyTicket(env, kind, ticketId) {
  try {
    const settings = await getSettings(env);
    const t = await env.DB.prepare(TICKET_SELECT + ' WHERE t.id = ?').bind(ticketId).first();
    if (!t) return;
    const team = await ticketPeople(env, t.team_id);
    const assignee = t.assignee_active ? { id: t.assigned_to, email: t.assignee_email } : null;
    let to = [];
    if (kind === 'new' || kind === 'transferred') to = t.priority === 1 ? [...team.supervisors, ...team.techs] : team.supervisors.length ? team.supervisors : team.techs;
    else if (kind === 'assigned') to = [assignee];
    else if (kind === 'reopened') to = [assignee, ...team.supervisors];
    else if (kind === 'repeat' || kind === 'low_rating') {
      to = team.supervisors;
      if (!to.length) to = (await env.DB.prepare("SELECT id, email FROM users WHERE active = 1 AND role IN ('super_admin', 'systems_admin')").all()).results;
    }
    to = to.filter(Boolean);
    const emails = emailsOf(to);
    const mail = mailReady(settings) && emails.length ? sendMail(settings, [{ to: emails.join(','), ...bothLangs(settings, (s) => ticketMail(s, kind, t)) }]) : null;
    const [result] = await Promise.all([mail, sendPush(env, to.map((u) => u.id), ticketPush(kind, t, settings))]);
    if (result && !result.ok) await logStmt(env, null, 'notify_failed', 'ticket', t.id, '#' + t.id, { error: result.error }).run();
  } catch (e) {
    console.error('notifyTicket', e);
  }
}

// The hidden problem type a team's planned work is filed under, made the first time it is needed.
export async function pmCategory(env, teamId) {
  const row = await env.DB.prepare('SELECT id FROM ticket_categories WHERE team_id = ? AND pm = 1').bind(teamId).first();
  if (row) return row.id;
  const res = await env.DB.prepare("INSERT INTO ticket_categories (name_ar, name_en, team_id, priority, active, pm, created_at) VALUES ('صيانة مجدولة', 'Planned maintenance', ?, 3, 0, 1, ?)").bind(teamId, nowIso()).run();
  return res.meta.last_row_id;
}

// After a new or transferred request (once the answer is sent): flag a repeated fault, hand the
// request to a technician when the team does that on its own, then tell the right people.
export async function afterNewTicket(env, kind, ticketId) {
  try {
    const t = await env.DB.prepare('SELECT id, status, priority, category_id, team_id, location_id, asset_tag, assigned_to, pm_plan_id, created_at FROM tickets WHERE id = ?').bind(ticketId).first();
    if (!t) return;
    const stmts = [];
    let repeat = 0;
    if (kind === 'new' && !t.pm_plan_id && (t.location_id || t.asset_tag)) {
      const same = [];
      const binds = [t.category_id, new Date(Date.parse(t.created_at) - REPEAT_DAYS * 86400000).toISOString()];
      if (t.location_id) same.push(`location_id = ?${binds.push(t.location_id)}`);
      if (t.asset_tag) same.push(`asset_tag = ?${binds.push(t.asset_tag)}`);
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE category_id = ?1 AND created_at >= ?2 AND pm_plan_id IS NULL AND (${same.join(' OR ')})`).bind(...binds).first();
      if (row.n >= REPEAT_MIN) {
        repeat = row.n;
        stmts.push(env.DB.prepare('UPDATE tickets SET repeat_n = ? WHERE id = ?').bind(repeat, t.id), eventStmt(env, t.id, null, 'repeat', null, { n: repeat, days: REPEAT_DAYS }));
      }
    }
    // The technician with the fewest open requests; on a tie, the one who got a request longest ago.
    const team = await env.DB.prepare('SELECT auto_assign FROM departments WHERE id = ?').bind(t.team_id).first();
    let to = null;
    if (team && team.auto_assign && t.status === 'new' && !t.assigned_to) {
      to = await env.DB.prepare(
        `SELECT u.id, u.name, u.name_en FROM users u
          WHERE u.active = 1 AND u.department_id = ?1 AND u.role NOT IN ('super_admin', 'systems_admin') AND u.desk_role = 'technician'
          ORDER BY (SELECT COUNT(*) FROM tickets x WHERE x.assigned_to = u.id AND x.status <> 'closed'),
                   COALESCE((SELECT MAX(x.created_at) FROM tickets x WHERE x.assigned_to = u.id AND x.id <> ?2), ''), u.id
          LIMIT 1`,
      ).bind(t.team_id, t.id).first();
      if (to) {
        stmts.push(
          env.DB.prepare("UPDATE tickets SET assigned_to = ? WHERE id = ? AND status = 'new' AND assigned_to IS NULL").bind(to.id, t.id),
          eventStmt(env, t.id, null, 'assigned', null, { to: to.name, to_en: to.name_en || to.name, auto: true }),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    // Handed out: the technician hears about it, and the whole team too when it is critical.
    if (to) await notifyTicket(env, 'assigned', t.id);
    if (!to || t.priority === 1) await notifyTicket(env, kind, t.id);
    if (repeat) await notifyTicket(env, 'repeat', t.id);
  } catch (e) {
    console.error('afterNewTicket', e);
  }
}

// The AI assistant runs on Cloudflare Workers AI (the "AI" binding in wrangler.jsonc): free up to a
// daily allowance, and Cloudflare does not train on what is sent. Every call is counted per day and
// stops at ai_daily_limit. Without the binding, switched off, or past the limit, nothing is suggested
// and everything else works as before.
export const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const aiReady = (env, settings) => !!env.AI && settings.ai_enabled === '1' && settings.ai_daily_limit > 0;
export async function aiTake(env, settings) {
  const row = await env.DB.prepare('INSERT INTO ai_usage (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n').bind(nowIso().slice(0, 10)).first();
  return row.n <= settings.ai_daily_limit;
}
// Asks for a JSON answer. Returns the parsed object, or null when the model gave nothing usable.
export async function aiJson(env, system, user, schema) {
  const out = await env.AI.run(AI_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
    max_tokens: 100,
    temperature: 0,
  });
  const r = out && out.response;
  if (r && typeof r === 'object') return r;
  const text = typeof r === 'string' ? r : (out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || '';
  const m = text.match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}
// The problem type that fits what the employee wrote, from the active types only.
export async function suggestCategory(env, description, categories) {
  const list = categories.map((c) => `${c.id}: ${c.name_ar} / ${c.name_en} (${c.team_ar} / ${c.team_en})`).join('\n');
  const r = await aiJson(
    env,
    'You sort maintenance and service requests in an organization\'s buildings (a hospital, school, hotel, office...). The request is written by an employee, usually in Arabic. ' +
      'Pick the one problem type from the list that best fits the request. Answer with its id only, as JSON. ' +
      'If none fits, answer {"category_id": 0}.\n\nProblem types (id: Arabic / English (team)):\n' + list,
    description,
    { type: 'object', properties: { category_id: { type: 'integer' } }, required: ['category_id'] },
  );
  const id = r ? Number(r.category_id) : 0;
  return categories.some((c) => c.id === id) ? id : null;
}

// Every 15 minutes. Late once = the team (and the technician); late by twice the allowed time = super admins too.
export async function runTicketAlerts(env) {
  const settings = await getSettings(env);
  const mail = mailReady(settings);
  if (!mail && !(await env.DB.prepare('SELECT 1 FROM push_subs LIMIT 1').first())) return { ok: false, error: 'mail_not_configured' };
  const now = nowIso();
  const { results } = await env.DB.prepare(
    `${TICKET_SELECT}
      WHERE (t.status = 'new' AND t.response_due < ?1 AND t.esc_resp < 2)
         OR (t.status = 'in_progress' AND COALESCE(t.expected_at, t.resolve_due) < ?1 AND t.esc_res < 2)
      ORDER BY t.priority, t.id LIMIT ${ALERTS_PER_RUN}`,
  )
    .bind(now)
    .all();
  if (!results.length) return { ok: true, tickets: 0 };
  const { results: supers } = await env.DB.prepare("SELECT id, email FROM users WHERE active = 1 AND role IN ('super_admin', 'systems_admin')").all();
  const people = new Map();
  const messages = [];
  const pushes = [];
  const updates = [];
  for (const t of results) {
    const isNew = t.status === 'new';
    const due = isNew ? t.response_due : t.expected_at || t.resolve_due;
    const start = isNew ? t.created_at : t.received_at || t.created_at;
    const window = Math.max(Date.parse(due) - Date.parse(start), 15 * 60000);
    const level = Date.now() > Date.parse(due) + window ? 2 : 1;
    const sent = isNew ? t.esc_resp : t.esc_res;
    if (level <= sent) continue;
    if (!people.has(t.team_id)) people.set(t.team_id, await ticketPeople(env, t.team_id));
    const team = people.get(t.team_id);
    const assignee = t.assignee_active ? { id: t.assigned_to, email: t.assignee_email } : null;
    let to = [assignee, ...team.supervisors];
    if (isNew && !team.supervisors.length) to.push(...team.techs);
    if (level === 2) to.push(...supers);
    to = to.filter(Boolean);
    const emails = emailsOf(to);
    const kind = level === 2 ? 'escalate' : isNew ? 'late_response' : 'late_resolve';
    pushes.push([to.map((u) => u.id), ticketPush(kind, t, settings)]);
    if (mail && emails.length) messages.push({ to: emails.join(','), ...bothLangs(settings, (s) => ticketMail(s, kind, t)) });
    updates.push(env.DB.prepare(`UPDATE tickets SET ${isNew ? 'esc_resp' : 'esc_res'} = ? WHERE id = ?`).bind(level, t.id));
    updates.push(eventStmt(env, t.id, null, 'alert', null, { level, kind: isNew ? 'response' : 'resolve' }));
  }
  if (!updates.length) return { ok: true, tickets: 0 };
  if (messages.length) {
    const result = await sendMail(settings, messages);
    if (!result.ok) {
      await logStmt(env, null, 'notify_failed', 'ticket', null, null, { error: result.error, tickets: updates.length / 2 }).run();
      return { ok: false, error: result.error };
    }
  }
  await env.DB.batch(updates);
  // One read for every device concerned, then the most urgent first (the list is in priority order),
  // until the run's fetches are spent.
  const subs = await pushSubsOf(env, pushes.flatMap(([ids]) => ids), 200);
  let left = PUSH_PER_EVENT;
  const jobs = pushes.map(([ids, build]) => {
    const mine = subs.filter((x) => ids.includes(x.user_id)).slice(0, Math.max(0, left));
    left -= mine.length;
    return { subs: mine, build };
  });
  const pushed = (await deliverPush(env, jobs)).sent;
  return { ok: true, tickets: updates.length / 2, emails: messages.length, pushed };
}

// The tickets one user works on or follows, for the list and the menu badge.
export function ticketScope(user) {
  if (user.desk === 'admin') return { where: '1 = 1', binds: [] };
  if (user.desk === 'supervisor') return { where: '(t.team_id = ?1 OR t.requester_dept_id = ?1)', binds: [user.department_id ?? 0] };
  if (user.desk === 'technician') return { where: 't.team_id = ?1', binds: [user.department_id ?? 0] };
  if (user.desk === 'dept') return { where: 't.requester_dept_id = ?1', binds: [user.department_id ?? 0] };
  return null;
}

/* public ticket page: no account; the employee number is checked against the staff list */

export async function handlePublicTickets(request, env, url, seg, method, ctx) {
  // GET /public/form?loc=<code>: what the request form needs.
  if (method === 'GET' && seg[1] === 'form' && seg.length === 2) {
    const settings = await getSettings(env);
    const code = str(url.searchParams.get('loc'), 40);
    const tag = str(url.searchParams.get('asset'), 60);
    const [{ results: departments }, { results: categories }, loc, asset, { results: places }] = await Promise.all([
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
      env.DB.prepare(
        `SELECT c.id, c.name_ar, c.name_en, c.team_id, c.priority, d.name_ar AS team_ar, d.name_en AS team_en
           FROM ticket_categories c JOIN departments d ON d.id = c.team_id WHERE c.active = 1 ORDER BY d.id, c.id`,
      ).all(),
      code
        ? env.DB.prepare(
            `SELECT l.id, l.name_ar, l.name_en, l.department_id,
                    (SELECT COUNT(*) FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1 WHERE p.location_id = l.id) AS rounds
               FROM locations l WHERE l.code = ? AND l.active = 1`,
          ).bind(code).first()
        : null,
      // An asset's own QR: the form starts with its number and shows its team's problem types first.
      tag
        ? env.DB.prepare("SELECT a.id, a.tag, a.name_ar, a.name_en, ty.team_id FROM assets a LEFT JOIN asset_types ty ON ty.id = a.type_id WHERE a.tag = ? AND a.status <> 'retired'").bind(tag).first()
        : null,
      // Without a QR the employee picks the place from this list (names only: the codes stay on the printed labels).
      code || settings.require_qr === '1' ? { results: [] } : env.DB.prepare('SELECT id, name_ar, name_en FROM locations WHERE active = 1 ORDER BY name_ar LIMIT 1000').all(),
    ]);
    return json({ departments, categories, places, location: loc || null, asset: asset || null, bad_location: !!code && !loc, require_qr: settings.require_qr === '1', staff_check: true, ai: aiReady(env, settings) });
  }

  // GET /public/staff?emp_no=: who this employee number belongs to, so the form needs only the number.
  // The name is shortened (first name and an initial) so the page never lists full names.
  if (method === 'GET' && seg[1] === 'staff' && seg.length === 2) {
    const emp_no = str(url.searchParams.get('emp_no'), 30);
    const ipHash = 'st:' + (await hashIp(request));
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const hits = await env.DB.prepare('SELECT COUNT(*) AS n FROM public_hits WHERE ip_hash = ? AND at > ?').bind(ipHash, hourAgo).first();
    if (hits.n >= LOOKUPS_PER_HOUR) fail(429, 'too_many_requests');
    await env.DB.prepare('INSERT INTO public_hits (ip_hash, at) VALUES (?, ?)').bind(ipHash, nowIso()).run();
    const m = emp_no
      ? await env.DB.prepare('SELECT s.name, s.name_en, s.department_id, d.name_ar AS dept_ar, d.name_en AS dept_en FROM staff s LEFT JOIN departments d ON d.id = s.department_id WHERE s.emp_no = ? AND s.active = 1').bind(emp_no).first()
      : null;
    if (!m) return json({ found: false });
    const short = (v) => {
      const w = String(v || '').trim().split(/\s+/).filter(Boolean);
      return w.length > 1 ? `${w[0]} ${w[w.length - 1].charAt(0)}.` : w[0] || '';
    };
    return json({ found: true, name_ar: short(m.name), name_en: short(m.name_en || m.name), department_id: m.department_id, dept_ar: m.dept_ar || '', dept_en: m.dept_en || '' });
  }

  // POST /public/suggest {description}: the problem type the AI assistant would pick. {} when it has none.
  if (method === 'POST' && seg[1] === 'suggest' && seg.length === 2) {
    const body = await readJson(request);
    const description = str(body.description, 1000);
    const settings = await getSettings(env);
    if (description.length < 10 || !aiReady(env, settings)) return json({});
    const ipHash = 'ai:' + (await hashIp(request));
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const hits = await env.DB.prepare('SELECT COUNT(*) AS n FROM public_hits WHERE ip_hash = ? AND at > ?').bind(ipHash, hourAgo).first();
    if (hits.n >= SUGGEST_PER_HOUR) return json({});
    await env.DB.prepare('INSERT INTO public_hits (ip_hash, at) VALUES (?, ?)').bind(ipHash, nowIso()).run();
    if (!(await aiTake(env, settings))) return json({});
    const { results: categories } = await env.DB.prepare(
      `SELECT c.id, c.name_ar, c.name_en, d.name_ar AS team_ar, d.name_en AS team_en
         FROM ticket_categories c JOIN departments d ON d.id = c.team_id WHERE c.active = 1 ORDER BY c.id`,
    ).all();
    if (!categories.length) return json({});
    try {
      const id = await suggestCategory(env, description, categories);
      return json(id ? { category_id: id } : {});
    } catch (e) {
      console.error('suggest', e);
      return json({});
    }
  }

  if (method === 'POST' && seg[1] === 'tickets' && seg.length === 2) {
    const form = await request.formData().catch(() => fail(400, 'bad_request'));
    if (str(form.get('website'), 100)) fail(400, 'bad_request'); // a field people never see; bots fill it
    checkLang((k) => form.get(k), [], ['emp_no', 'phone', 'asset_tag']);
    const settings = await getSettings(env);
    const emp_no = str(form.get('emp_no'), 30);
    const phone = str(form.get('phone'), 30);
    const description = str(form.get('description'), 2000);
    const asset_tag = str(form.get('asset_tag'), 60);
    const location_text = str(form.get('location_text'), 200);
    const department_id = toInt(form.get('department_id'));
    const category_id = toInt(form.get('category_id'));
    const impact = form.get('impact') === '1' ? 1 : 0;
    if (!emp_no) fail(400, 'requester_required');
    if (!description) fail(400, 'description_required');

    const ipHash = await hashIp(request);
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const [hits, byStaff] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM public_hits WHERE ip_hash = ? AND at > ?').bind(ipHash, hourAgo).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE requester_emp_no = ? AND created_at > ?').bind(emp_no, hourAgo).first(),
    ]);
    if (hits.n >= PUBLIC_PER_HOUR || byStaff.n >= STAFF_PER_HOUR) fail(429, 'too_many_requests');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM public_hits WHERE at < ?').bind(hourAgo),
      env.DB.prepare('INSERT INTO public_hits (ip_hash, at) VALUES (?, ?)').bind(ipHash, nowIso()),
    ]);

    const [cat, member] = await Promise.all([
      category_id ? env.DB.prepare('SELECT * FROM ticket_categories WHERE id = ? AND active = 1').bind(category_id).first() : null,
      env.DB.prepare('SELECT * FROM staff WHERE emp_no = ?').bind(emp_no).first(),
    ]);
    if (!cat) fail(400, 'type_required');
    // Only people on the active staff list can send a request, even while the list is empty. The employee
    // number alone identifies the person: the name and the department come from the list (the department
    // typed on the form only when the list has none).
    if (!member || !member.active) fail(403, 'staff_unknown');
    const deptId = member.department_id || department_id;
    const dept = deptId ? await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(deptId).first() : null;
    if (!dept) fail(400, 'department_required');
    const code = str(form.get('loc'), 40);
    const placeId = toInt(form.get('location_id'));
    const loc = code
      ? await env.DB.prepare('SELECT id FROM locations WHERE code = ? AND active = 1').bind(code).first()
      : placeId && settings.require_qr !== '1'
        ? await env.DB.prepare('SELECT id FROM locations WHERE id = ? AND active = 1').bind(placeId).first()
        : null;
    if (settings.require_qr === '1' && !loc) fail(403, 'qr_required');

    let photo = null;
    const f = form.get('photo');
    if (f && typeof f !== 'string' && f.size) {
      if (f.size > MAX_PHOTO_BYTES) fail(413, 'photo_too_large');
      const bytes = await f.arrayBuffer();
      const type = photoType(bytes);
      if (!type) fail(400, 'photo_bad_type');
      photo = { bytes, type, key: `ticket/${crypto.randomUUID()}` };
    }

    const assetRow = asset_tag ? await env.DB.prepare('SELECT id FROM assets WHERE tag = ?').bind(asset_tag).first() : null;
    const priority = ticketPriority(cat.priority, impact);
    const sla = slaFor(settings, priority);
    const now = nowIso();
    const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
    if (photo) await env.FILES.put(photo.key, photo.bytes, { httpMetadata: { contentType: photo.type } });
    let id;
    try {
      const res = await env.DB.prepare(
        `INSERT INTO tickets (status, priority, patient_impact, category_id, team_id, staff_id, requester_emp_no, requester_name, requester_dept_id, requester_phone,
                              location_id, location_text, asset_tag, asset_id, description, photo_key, photo_type, response_due, resolve_due, track_hash, ip_hash, created_at, updated_at)
         VALUES ('new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          priority, impact, cat.id, cat.team_id, member ? member.id : null, emp_no, member.name, dept.id, phone || (member && member.phone) || null,
          loc ? loc.id : null, location_text || null, asset_tag || null, assetRow ? assetRow.id : null, description, photo ? photo.key : null, photo ? photo.type : null,
          addMinutes(now, sla.resp), addMinutes(now, sla.res), await sha256Hex(token), ipHash, now, now,
        )
        .run();
      id = res.meta.last_row_id;
      await eventStmt(env, id, { id: null, name: member.name }, 'created').run();
    } catch (e) {
      if (photo) await env.FILES.delete(photo.key);
      throw e;
    }
    ctx.waitUntil(afterNewTicket(env, 'new', id));
    return json({ ok: true, id, token });
  }

  // The employee's own view of a ticket, by its number and the secret in the tracking link.
  if (seg[1] === 'tickets' && seg[2] && /^\d+$/.test(seg[2])) {
    const id = Number(seg[2]);
    const token = method === 'GET' ? str(url.searchParams.get('t'), 64) : null;
    const body = method === 'POST' ? await readJson(request) : null;
    const secret = token ?? str(body && body.t, 64);
    if (!/^[0-9a-f]{32}$/.test(secret || '')) fail(404, 'not_found');
    const t = await env.DB.prepare(TICKET_SELECT + ' WHERE t.id = ? AND t.track_hash = ?').bind(id, await sha256Hex(secret)).first();
    if (!t) fail(404, 'not_found');
    const canFeedback = t.status === 'closed' && !t.rated_at && Date.now() - Date.parse(t.closed_at) < REOPEN_DAYS * 86400000;

    if (method === 'GET' && seg.length === 3) {
      const { results: events } = await env.DB.prepare(
        "SELECT at, actor, kind, note, data FROM ticket_events WHERE ticket_id = ? AND kind IN ('created', 'received', 'assigned', 'hold', 'resume', 'closed', 'reopened', 'feedback') ORDER BY id",
      ).bind(id).all();
      const o = ticketOut(t, nowIso());
      return json({
        ticket: {
          id: o.id, status: o.status, priority: o.priority, cat_ar: o.cat_ar, cat_en: o.cat_en, team_ar: o.team_ar, team_en: o.team_en,
          description: o.description, created_at: o.created_at, received_at: o.received_at, assignee_name: o.assignee_name, assignee_name_en: o.assignee_name_en || o.assignee_name, assignee_title: o.assignee_title,
          expected_at: o.expected_at || (o.status === 'new' ? null : o.resolve_due), hold_reason: o.hold_reason, closed_at: o.closed_at,
          resolution: o.resolution, close_code: o.close_code, close_note: o.close_note, rating: o.rating, can_feedback: canFeedback,
        },
        // Only what the employee needs: no comments between technicians.
        events: events.map((e) => ({ at: e.at, actor: e.kind === 'created' || e.kind === 'feedback' ? '' : e.actor, kind: e.kind, note: e.kind === 'hold' || e.kind === 'closed' ? e.note : null, data: e.data })),
      });
    }

    // Rate the fix, or say the problem is still there (which reopens the ticket).
    if (method === 'POST' && seg[3] === 'feedback') {
      if (!canFeedback) fail(409, 'feedback_closed');
      const note = str(body.note, 500);
      const actor = { id: null, name: t.requester_name };
      if (body.reopen) {
        const s = await getSettings(env);
        const now = nowIso();
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE tickets SET status = 'in_progress', closed_at = NULL, closed_by = NULL, resolution = NULL, close_code = NULL, reopen_count = reopen_count + 1, expected_at = NULL, resolve_due = ?, esc_res = 0, updated_at = ? WHERE id = ?",
          ).bind(addMinutes(now, slaFor(s, t.priority).res), now, id),
          eventStmt(env, id, actor, 'reopened', note, { by: 'requester' }),
        ]);
        ctx.waitUntil(notifyTicket(env, 'reopened', id));
        return json({ ok: true, reopened: true });
      }
      const rating = toInt(body.rating);
      if (!rating || rating < 1 || rating > 5) fail(400, 'rating_required');
      await env.DB.batch([
        env.DB.prepare('UPDATE tickets SET rating = ?, rating_note = ?, rated_at = ? WHERE id = ?').bind(rating, note || null, nowIso(), id),
        eventStmt(env, id, actor, 'feedback', note, { rating }),
      ]);
      if (rating <= LOW_RATING) ctx.waitUntil(notifyTicket(env, 'low_rating', id));
      return json({ ok: true });
    }
  }
  fail(404, 'not_found');
}

// Rows from an Excel sheet or another system, matched by employee number: new ones are added, known ones updated.
// keep = every number in the full list; anyone else is switched off, not deleted.
export async function importStaff(env, user, input, keepList) {
  const rows = Array.isArray(input) ? input.slice(0, MAX_STAFF_ROWS) : [];
  const clean = [];
  const seen = new Set();
  for (const r of rows) {
    const emp_no = str(r && r.emp_no, 30);
    const name = str(r && r.name, 100);
    const name_en = str(r && r.name_en, 100);
    if (!emp_no || !name || !name_en || seen.has(emp_no)) continue;
    seen.add(emp_no);
    const dep = toInt(r.department_id);
    const email = str(r.email, 160).toLowerCase();
    clean.push({ emp_no, name, name_en, department_id: dep && dep > 0 ? dep : null, phone: str(r.phone, 30) || null, email: EMAIL_RE.test(email) ? email : null, job_title: str(r.job_title, 120) || null, active: r.active === false ? 0 : 1 });
  }
  const known = new Set((await env.DB.prepare('SELECT emp_no FROM staff').all()).results.map((r) => r.emp_no));
  const now = nowIso();
  const stmts = [];
  if (clean.length) {
    // One statement for the whole sheet (the free plan counts queries, not rows).
    stmts.push(
      env.DB.prepare(
        `INSERT INTO staff (emp_no, name, name_en, department_id, phone, email, job_title, active, created_at, updated_at)
         SELECT json_extract(value, '$.emp_no'), json_extract(value, '$.name'), json_extract(value, '$.name_en'), json_extract(value, '$.department_id'), json_extract(value, '$.phone'),
                json_extract(value, '$.email'), json_extract(value, '$.job_title'), json_extract(value, '$.active'), ?2, ?2
           FROM json_each(?1) WHERE true
         ON CONFLICT(emp_no) DO UPDATE SET name = excluded.name, name_en = excluded.name_en, department_id = COALESCE(excluded.department_id, staff.department_id),
                                           phone = COALESCE(excluded.phone, staff.phone), email = COALESCE(excluded.email, staff.email), job_title = COALESCE(excluded.job_title, staff.job_title),
                                           active = excluded.active, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify(clean), now),
    );
  }
  let deactivated = 0;
  if (Array.isArray(keepList)) {
    const keep = keepList.map((v) => str(v, 30)).filter(Boolean);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND emp_no NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(keep)).first();
    deactivated = row.n;
    stmts.push(env.DB.prepare('UPDATE staff SET active = 0, updated_at = ? WHERE active = 1 AND emp_no NOT IN (SELECT value FROM json_each(?))').bind(now, JSON.stringify(keep)));
  }
  const added = clean.filter((r) => !known.has(r.emp_no)).length;
  const updated = clean.length - added;
  stmts.push(membersFromStaffStmt(env), logStmt(env, user, 'import', 'staff', null, null, { added, updated, deactivated }));
  await env.DB.batch(stmts);
  return { ok: true, added, updated, deactivated, skipped: rows.length - clean.length };
}

/* signed-in ticket routes */

export async function handleTickets(request, env, url, seg, method, user, ctx) {
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  const scope = ticketScope(user);

  // Problem types, teams, places: everything the tickets pages need to draw their filters and forms.
  if (method === 'GET' && seg[0] === 'tickets' && seg[1] === 'meta') {
    if (!scope) fail(403, 'forbidden');
    const [{ results: categories }, { results: teams }, { results: members }] = await Promise.all([
      env.DB.prepare('SELECT c.*, (SELECT COUNT(*) FROM tickets t WHERE t.category_id = c.id) AS ticket_count FROM ticket_categories c ORDER BY c.team_id, c.id').all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 1 ORDER BY id').all(),
      env.DB.prepare(
        "SELECT id, name, name_en, desk_role AS role, department_id, job_title FROM users WHERE active = 1 AND role NOT IN ('super_admin', 'systems_admin') AND desk_role IN ('technician', 'supervisor') AND department_id IN (SELECT id FROM departments WHERE is_team = 1) ORDER BY name",
      ).all(),
    ]);
    return json({ categories, teams, members });
  }

  // Red number in the menu: new tickets to take, and late ones, for the teams this user works in.
  if (method === 'GET' && seg[0] === 'tickets' && seg[1] === 'badge') {
    if (!scope || user.desk === 'dept') return json({ count: 0 });
    const work = user.desk === 'admin' ? '1 = 1' : 't.team_id = ?2';
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tickets t WHERE ${work} AND (t.status = 'new' OR (t.status = 'in_progress' AND COALESCE(t.expected_at, t.resolve_due) < ?1))`,
    )
      .bind(nowIso(), ...(user.desk === 'admin' ? [] : [user.department_id ?? 0]))
      .first();
    return json({ count: row.n });
  }

  if (method === 'GET' && seg[0] === 'tickets' && seg.length === 1) {
    if (!scope) fail(403, 'forbidden');
    const days = [30, 90, 365].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { results } = await env.DB.prepare(
      `${TICKET_SELECT} WHERE ${scope.where.replace(/\?1/g, '?2')} AND (t.status <> 'closed' OR t.closed_at >= ?1) ORDER BY t.id DESC LIMIT 3000`,
    )
      .bind(since, ...scope.binds)
      .all();
    const now = nowIso();
    return json({ tickets: results.map((t) => ticketOut(t, now)), days, now });
  }

  if (seg[0] === 'tickets' && id !== null) {
    const t = await env.DB.prepare(TICKET_SELECT + ' WHERE t.id = ?').bind(id).first();
    if (!t || !canSeeTicket(user, t)) fail(404, 'not_found');

    if (method === 'GET' && seg.length === 2) {
      const { results: events } = await env.DB.prepare('SELECT id, at, actor, kind, note, data FROM ticket_events WHERE ticket_id = ? ORDER BY id').bind(id).all();
      const covered = t.asset_id ? await assetContract(env, t.asset_id, todayIn((await getSettings(env)).timezone)) : null;
      return json({ ticket: ticketOut(t, nowIso()), events, can_work: canWorkTicket(user, t), can_supervise: canSuperviseTicket(user, t), asset_contract: covered });
    }

    if (method === 'GET' && seg[2] === 'photo') {
      const obj = t.photo_key ? await env.FILES.get(t.photo_key) : null;
      if (!obj) fail(404, 'not_found');
      return new Response(obj.body, {
        headers: { 'content-type': t.photo_type || 'image/jpeg', 'content-length': String(obj.size), 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' },
      });
    }

    // GET /tickets/:id/person?who=assignee|requester&days=: how this person's requests went, within what the viewer may see.
    // A technician's record is for the team's supervisor, the desk admin and the technician only.
    if (method === 'GET' && seg[2] === 'person' && seg.length === 3) {
      const who = url.searchParams.get('who') === 'assignee' ? 'assignee' : 'requester';
      if (who === 'assignee' && (!t.assigned_to || !(canSuperviseTicket(user, t) || user.id === t.assigned_to))) fail(403, 'forbidden');
      const days = [30, 90, 365].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 90;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const scope = ticketScope(user);
      const mine = who === 'assignee' ? 't.assigned_to = ?1' : 't.requester_emp_no = ?1';
      const where = `${mine} AND (t.created_at >= ?2 OR t.status <> 'closed') AND ${scope.where.replace(/\?1/g, '?3')}`;
      const binds = [who === 'assignee' ? t.assigned_to : t.requester_emp_no, since, ...scope.binds];
      const [sum, { results: cats }, { results: recent }, person] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) AS n, SUM(t.status <> 'closed') AS open, SUM(t.status = 'closed') AS closed,
                  SUM(t.received_at IS NOT NULL) AS recv, SUM(t.received_at <= t.response_due) AS recv_ok,
                  SUM(t.closed_at <= t.resolve_due) AS fix_ok, SUM(t.status = 'closed' AND t.resolution <> 'unresolved') AS resolved,
                  AVG((julianday(t.received_at) - julianday(t.created_at)) * 1440) AS recv_min,
                  AVG((julianday(t.closed_at) - julianday(t.created_at)) * 1440) AS fix_min,
                  AVG(t.rating) AS rating, COUNT(t.rating) AS rated, SUM(t.reopen_count > 0) AS reopened,
                  SUM(t.patient_impact) AS impact, SUM(t.status <> 'closed' AND COALESCE(t.expected_at, t.resolve_due) < ?${binds.length + 1}) AS late
             FROM tickets t WHERE ${where}`,
        )
          .bind(...binds, nowIso())
          .first(),
        env.DB.prepare(
          `SELECT c.name_ar, c.name_en, COUNT(*) AS n FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id WHERE ${where} GROUP BY t.category_id ORDER BY n DESC LIMIT 3`,
        )
          .bind(...binds)
          .all(),
        env.DB.prepare(`SELECT t.id, t.status, t.priority, t.created_at, c.name_ar AS cat_ar, c.name_en AS cat_en FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id WHERE ${where} ORDER BY t.id DESC LIMIT 6`)
          .bind(...binds)
          .all(),
        who === 'assignee'
          ? env.DB.prepare('SELECT u.name, u.name_en, u.job_title, u.active, d.name_ar AS dept_ar, d.name_en AS dept_en FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?').bind(t.assigned_to).first()
          : env.DB.prepare('SELECT s.name, s.name_en, s.active, d.name_ar AS dept_ar, d.name_en AS dept_en FROM staff s LEFT JOIN departments d ON d.id = s.department_id WHERE s.emp_no = ?').bind(t.requester_emp_no).first(),
      ]);
      const num = (v) => Number(v) || 0;
      const p = person || { name: who === 'assignee' ? t.assignee_name : t.requester_name, active: 0 };
      return json({
        who,
        days,
        person: {
          name: p.name,
          name_en: p.name_en || p.name,
          job_title: p.job_title || '',
          emp_no: who === 'requester' ? t.requester_emp_no : '',
          dept_ar: p.dept_ar || '',
          dept_en: p.dept_en || '',
          active: !!p.active,
        },
        stats: {
          total: num(sum.n),
          open: num(sum.open),
          closed: num(sum.closed),
          late: num(sum.late),
          received: num(sum.recv),
          received_on_time: num(sum.recv_ok),
          fixed_on_time: num(sum.fix_ok),
          resolved: num(sum.resolved),
          avg_receive_min: sum.recv_min === null ? null : Math.round(sum.recv_min),
          avg_fix_min: sum.fix_min === null ? null : Math.round(sum.fix_min),
          rating: sum.rating === null ? null : Math.round(sum.rating * 10) / 10,
          rated: num(sum.rated),
          reopened: num(sum.reopened),
          impact: num(sum.impact),
        },
        categories: cats,
        recent,
      });
    }

    if (method === 'DELETE' && seg.length === 2) {
      requireRole(user, ...ADMIN_ROLES);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM tickets WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM ticket_events WHERE ticket_id = ?').bind(id),
        logStmt(env, user, 'delete', 'ticket', id, `#${id} ${t.requester_name}`),
      ]);
      if (t.photo_key) await env.FILES.delete(t.photo_key);
      return json({ ok: true });
    }

    if (method === 'POST' && seg[2] === 'action') {
      const body = await readJson(request);
      const action = str(body.action, 20);
      const note = str(body.note, 2000);
      const settings = await getSettings(env);
      const now = nowIso();
      const work = canWorkTicket(user, t);
      const boss = canSuperviseTicket(user, t);
      const stmts = [];
      const update = (sql, ...binds) => stmts.push(env.DB.prepare(`UPDATE tickets SET ${sql}, updated_at = ? WHERE id = ?`).bind(...binds, now, id));
      const event = (kind, n, data) => stmts.push(eventStmt(env, id, user, kind, n, data));
      // A time after the priority's target needs a reason, so the delay is explained in the record.
      const expected = () => {
        const at = isoTime(body.expected_at);
        if (at < new Date(Date.now() - 5 * 60000).toISOString() || at > addMinutes(now, 366 * 1440)) fail(400, 'invalid_time');
        if (at > t.resolve_due && !note) fail(400, 'reason_required');
        return at;
      };
      let mail = null;

      if (action === 'receive') {
        if (!work) fail(403, 'forbidden');
        if (t.status !== 'new') fail(409, 'ticket_changed');
        const at = expected();
        update("status = 'in_progress', assigned_to = ?, received_at = ?, expected_at = ?, esc_res = 0", user.id, now, at);
        event('received', note, { expected_at: at });
      } else if (action === 'assign') {
        if (!boss) fail(403, 'forbidden');
        if (t.status === 'closed') fail(409, 'ticket_changed');
        const to = await env.DB.prepare("SELECT id, name, name_en FROM users WHERE id = ? AND active = 1 AND department_id = ? AND role NOT IN ('super_admin', 'systems_admin') AND desk_role IN ('technician', 'supervisor')").bind(toInt(body.user_id) ?? 0, t.team_id).first();
        if (!to) fail(400, 'member_required');
        const at = body.expected_at ? expected() : t.expected_at || t.resolve_due;
        update(
          "status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END, assigned_to = ?, received_at = COALESCE(received_at, ?), expected_at = ?, esc_res = 0",
          to.id, now, at,
        );
        event('assigned', note, { to: to.name, to_en: to.name_en || to.name, expected_at: at });
        if (to.id !== user.id) mail = 'assigned';
      } else if (action === 'expected') {
        if (!work) fail(403, 'forbidden');
        if (t.status !== 'in_progress') fail(409, 'ticket_changed');
        if (!note) fail(400, 'reason_required');
        const at = expected();
        update('expected_at = ?, esc_res = 0', at);
        event('expected', note, { from: t.expected_at, to: at });
      } else if (action === 'hold') {
        if (!work) fail(403, 'forbidden');
        if (t.status !== 'in_progress') fail(409, 'ticket_changed');
        const code = HOLD_CODES.includes(body.code) ? body.code : null;
        if (!code) fail(400, 'reason_required');
        update("status = 'on_hold', hold_since = ?, hold_reason = ?", now, code);
        event('hold', note, { code });
      } else if (action === 'resume') {
        if (!work) fail(403, 'forbidden');
        if (t.status !== 'on_hold') fail(409, 'ticket_changed');
        // The time on hold is added to every due time: it does not count against the team.
        const held = Math.max(0, Date.now() - Date.parse(t.hold_since));
        update("status = 'in_progress', hold_since = NULL, hold_reason = NULL, expected_at = ?, resolve_due = ?, esc_res = 0", shiftIso(t.expected_at, held), shiftIso(t.resolve_due, held));
        event('resume', note, { minutes: Math.round(held / 60000) });
      } else if (action === 'close') {
        if (!work) fail(403, 'forbidden');
        if (t.status === 'closed') fail(409, 'ticket_changed');
        const result = RESOLUTIONS.includes(body.result) ? body.result : null;
        if (!result) fail(400, 'result_required');
        const code = result === 'resolved' ? null : CLOSE_CODES.includes(body.code) ? body.code : null;
        if (result === 'unresolved' && !code) fail(400, 'reason_required');
        if (!note) fail(400, 'solution_required');
        const held = t.status === 'on_hold' ? Math.max(0, Date.now() - Date.parse(t.hold_since)) : 0;
        update(
          "status = 'closed', assigned_to = COALESCE(assigned_to, ?), received_at = COALESCE(received_at, ?), hold_since = NULL, closed_at = ?, closed_by = ?, resolution = ?, close_code = ?, close_note = ?, cause_note = ?, resolve_due = ?",
          user.id, now, now, user.id, result, code, note, str(body.cause, 500) || null, shiftIso(t.resolve_due, held),
        );
        event('closed', note, { result, code });
        if (t.pm_plan_id) stmts.push(...(await pmClosedStmts(env, settings, t, user, result)));
      } else if (action === 'reopen') {
        if (!boss) fail(403, 'forbidden');
        if (t.status !== 'closed') fail(409, 'ticket_changed');
        if (!note) fail(400, 'reason_required');
        update(
          "status = 'in_progress', closed_at = NULL, closed_by = NULL, resolution = NULL, close_code = NULL, reopen_count = reopen_count + 1, expected_at = NULL, resolve_due = ?, esc_res = 0",
          addMinutes(now, slaFor(settings, t.priority).res),
        );
        event('reopened', note);
      } else if (action === 'priority') {
        if (!boss) fail(403, 'forbidden');
        const p = toInt(body.priority);
        if (![1, 2, 3, 4].includes(p) || p === t.priority) fail(400, 'invalid_priority');
        if (!note) fail(400, 'reason_required');
        const sla = slaFor(settings, p);
        update('priority = ?, response_due = ?, resolve_due = ?, esc_resp = 0, esc_res = 0', p, addMinutes(t.created_at, sla.resp), addMinutes(t.created_at, sla.res));
        event('priority', note, { from: t.priority, to: p });
      } else if (action === 'transfer') {
        // Sent to the wrong team: it goes back to "new" for the right one.
        if (!work) fail(403, 'forbidden');
        if (t.status === 'closed') fail(409, 'ticket_changed');
        const cat = await env.DB.prepare('SELECT * FROM ticket_categories WHERE id = ? AND active = 1').bind(toInt(body.category_id) ?? 0).first();
        if (!cat || cat.id === t.category_id) fail(400, 'category_required');
        if (!note) fail(400, 'reason_required');
        const p = ticketPriority(cat.priority, t.patient_impact);
        const sla = slaFor(settings, p);
        update(
          "status = 'new', category_id = ?, team_id = ?, priority = ?, assigned_to = NULL, received_at = NULL, expected_at = NULL, hold_since = NULL, hold_reason = NULL, response_due = ?, resolve_due = ?, esc_resp = 0, esc_res = 0",
          cat.id, cat.team_id, p, addMinutes(now, sla.resp), addMinutes(t.created_at, sla.res) > addMinutes(now, sla.resp) ? addMinutes(t.created_at, sla.res) : addMinutes(now, sla.res),
        );
        event('transferred', note, { from: t.cat_ar, to: cat.name_ar });
        if (cat.team_id !== t.team_id) mail = 'transferred';
      } else if (action === 'vendor_call') {
        // Sent to a supplier: the time it was sent starts the supplier's agreed response time.
        if (!work) fail(403, 'forbidden');
        if (t.status === 'closed' || t.vendor_arrived_at) fail(409, 'ticket_changed');
        const vendor = await env.DB.prepare('SELECT id, name_ar, name_en FROM vendors WHERE id = ? AND active = 1').bind(toInt(body.vendor_id) ?? 0).first();
        if (!vendor) fail(400, 'vendor_required');
        const today = todayIn(settings.timezone);
        const contract = body.contract_id
          ? await env.DB.prepare('SELECT id, number FROM contracts WHERE id = ?1 AND vendor_id = ?2 AND start_date <= ?3 AND end_date >= ?3').bind(toInt(body.contract_id) ?? 0, vendor.id, today).first()
          : null;
        if (body.contract_id && !contract) fail(400, 'contract_required');
        // The form gives minutes only, so a time in the minute the request came in counts as that moment.
        const given = body.at ? isoTime(body.at) : now;
        if (given < addMinutes(t.created_at, -1) || given > addMinutes(now, 5)) fail(400, 'invalid_time');
        const at = given < t.created_at ? t.created_at : given;
        update('vendor_id = ?, contract_id = ?, vendor_called_at = ?', vendor.id, contract ? contract.id : null, at);
        event('vendor_called', note, { vendor: vendor.name_ar, vendor_en: vendor.name_en, contract: contract ? contract.number : null, at });
      } else if (action === 'vendor_arrived') {
        if (!work) fail(403, 'forbidden');
        if (!t.vendor_called_at || t.vendor_arrived_at) fail(409, 'ticket_changed');
        const given = body.at ? isoTime(body.at) : now;
        if (given < addMinutes(t.vendor_called_at, -1) || given > addMinutes(now, 5)) fail(400, 'invalid_time');
        const at = given < t.vendor_called_at ? t.vendor_called_at : given;
        const late = vendorLate({ ...t, vendor_arrived_at: at }, t.contract_id ? { response_hours: t.response_hours, penalty_per_hour: t.penalty_per_hour } : null, now);
        update('vendor_arrived_at = ?', at);
        event('vendor_arrived', note, { at, late_min: late.late_min });
      } else if (action === 'comment') {
        if (!work) fail(403, 'forbidden');
        if (!note) fail(400, 'note_required');
        event('comment', note);
      } else fail(400, 'bad_request');

      await env.DB.batch(stmts);
      if (mail === 'transferred') ctx.waitUntil(afterNewTicket(env, mail, id));
      else if (mail) ctx.waitUntil(notifyTicket(env, mail, id));
      return json({ ok: true });
    }
    fail(404, 'not_found');
  }

  /* problem types (super admin manages; signed-in people read them through /tickets/meta) */

  if (seg[0] === 'ticket-categories') {
    requireRole(user, ...ADMIN_ROLES);
    const readCategory = async () => {
      const body = await readJson(request);
      const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100), team_id: toInt(body.team_id), priority: toInt(body.priority), active: body.active === false ? 0 : 1 };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      if (![1, 2, 3, 4].includes(next.priority)) fail(400, 'invalid_priority');
      const team = next.team_id ? await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND is_team = 1').bind(next.team_id).first() : null;
      if (!team) fail(400, 'team_required');
      return next;
    };
    if (method === 'POST' && seg.length === 1) {
      const next = await readCategory();
      const res = await env.DB.prepare('INSERT INTO ticket_categories (name_ar, name_en, team_id, priority, active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(next.name_ar, next.name_en, next.team_id, next.priority, next.active, nowIso())
        .run();
      await logStmt(env, user, 'create', 'category', res.meta.last_row_id, next.name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    const cat = id !== null ? await env.DB.prepare('SELECT * FROM ticket_categories WHERE id = ?').bind(id).first() : null;
    if (!cat) fail(404, 'not_found');
    if (method === 'PUT') {
      const next = await readCategory();
      await env.DB.batch([
        env.DB.prepare('UPDATE ticket_categories SET name_ar = ?, name_en = ?, team_id = ?, priority = ?, active = ? WHERE id = ?').bind(next.name_ar, next.name_en, next.team_id, next.priority, next.active, id),
        logStmt(env, user, 'update', 'category', id, next.name_ar, changes(cat, next, ['name_ar', 'name_en', 'team_id', 'priority', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE category_id = ?').bind(id).first();
      if (used.n > 0) fail(409, 'category_has_tickets');
      await env.DB.batch([env.DB.prepare('DELETE FROM ticket_categories WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'category', id, cat.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* places with a QR code (super admin) */

  if (seg[0] === 'locations') {
    requireRole(user, ...ADMIN_ROLES);
    const newCode = () => toHex(crypto.getRandomValues(new Uint8Array(8)));
    if (method === 'GET' && seg.length === 1) {
      const { results } = await env.DB.prepare('SELECT l.*, (SELECT COUNT(*) FROM tickets t WHERE t.location_id = l.id) AS ticket_count FROM locations l ORDER BY l.id').all();
      return json({ locations: results });
    }
    const readLocation = async () => {
      const body = await readJson(request);
      const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100), department_id: toInt(body.department_id), active: body.active === false ? 0 : 1, renew: !!body.renew_code };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      if (next.department_id && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(next.department_id).first())) fail(400, 'department_required');
      return next;
    };
    if (method === 'POST' && seg.length === 1) {
      const next = await readLocation();
      const res = await env.DB.prepare('INSERT INTO locations (name_ar, name_en, department_id, code, active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(next.name_ar, next.name_en, next.department_id, newCode(), next.active, nowIso())
        .run();
      await logStmt(env, user, 'create', 'location', res.meta.last_row_id, next.name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    const loc = id !== null ? await env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first() : null;
    if (!loc) fail(404, 'not_found');
    if (method === 'PUT') {
      const next = await readLocation();
      const diff = changes(loc, next, ['name_ar', 'name_en', 'department_id', 'active']);
      // A new code makes every printed QR of this place stop working (for a leaked or photographed code).
      if (next.renew) diff.code = ['***', '***'];
      await env.DB.batch([
        env.DB.prepare('UPDATE locations SET name_ar = ?, name_en = ?, department_id = ?, active = ?, code = ? WHERE id = ?').bind(next.name_ar, next.name_en, next.department_id, next.active, next.renew ? newCode() : loc.code, id),
        logStmt(env, user, 'update', 'location', id, next.name_ar, diff),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE location_id = ?').bind(id).first();
      if (used.n > 0) fail(409, 'location_has_tickets');
      await env.DB.batch([env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'location', id, loc.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* staff list (super admin): who may send a request from the public page */

  if (seg[0] === 'staff') {
    requireRole(user, ...ADMIN_ROLES);
    if (method === 'GET' && seg.length === 1) {
      const { results } = await env.DB.prepare('SELECT * FROM staff ORDER BY name').all();
      return json({ staff: results });
    }
    // A long sheet comes in parts; keep (every number in the sheet) comes with the last part only.
    if (method === 'POST' && seg[1] === 'import') {
      const body = await readJson(request);
      return json(await importStaff(env, user, body.rows, body.keep));
    }
    const readMember = async () => {
      const body = await readJson(request);
      const next = { emp_no: str(body.emp_no, 30), name: str(body.name, 100), name_en: str(body.name_en, 100), department_id: toInt(body.department_id), phone: str(body.phone, 30) || null, email: str(body.email, 160).toLowerCase() || null, job_title: str(body.job_title, 120) || null, active: body.active === false ? 0 : 1 };
      if (next.email && !EMAIL_RE.test(next.email)) fail(400, 'invalid_email');
      if (!next.emp_no) fail(400, 'requester_required');
      if (!next.name || !next.name_en) fail(400, 'name_required');
      if (next.department_id && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(next.department_id).first())) fail(400, 'department_required');
      return next;
    };
    const taken = async (empNo, exceptId) => {
      if (await env.DB.prepare('SELECT id FROM staff WHERE emp_no = ? AND id <> ?').bind(empNo, exceptId).first()) fail(409, 'emp_no_taken');
    };
    if (method === 'POST' && seg.length === 1) {
      const next = await readMember();
      await taken(next.emp_no, 0);
      const now = nowIso();
      const res = await env.DB.prepare('INSERT INTO staff (emp_no, name, name_en, department_id, phone, email, job_title, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(next.emp_no, next.name, next.name_en, next.department_id, next.phone, next.email, next.job_title, next.active, now, now)
        .run();
      await env.DB.batch([membersFromStaffStmt(env), logStmt(env, user, 'create', 'staff', res.meta.last_row_id, `${next.name} (${next.emp_no})`)]);
      return json({ ok: true, id: res.meta.last_row_id });
    }
    const member = id !== null ? await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first() : null;
    if (!member) fail(404, 'not_found');
    if (method === 'PUT') {
      const next = await readMember();
      await taken(next.emp_no, id);
      await env.DB.batch([
        env.DB.prepare('UPDATE staff SET emp_no = ?, name = ?, name_en = ?, department_id = ?, phone = ?, email = ?, job_title = ?, active = ?, updated_at = ? WHERE id = ?').bind(next.emp_no, next.name, next.name_en, next.department_id, next.phone, next.email, next.job_title, next.active, nowIso(), id),
        membersFromStaffStmt(env),
        logStmt(env, user, 'update', 'staff', id, `${next.name} (${next.emp_no})`, changes(member, next, ['emp_no', 'name', 'name_en', 'department_id', 'phone', 'email', 'job_title', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'staff', id, `${member.name} (${member.emp_no})`)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  return null;
}

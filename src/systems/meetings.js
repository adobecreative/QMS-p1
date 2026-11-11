// Committees & meetings: the committees master (hospital committees, departmental meetings and one-off
// special meetings), their members, terms of reference and reference papers, the schedule made from each
// committee's frequency, and the invitations and reminders sent to the members by email and on their phones.
// Minutes, attendance and actions of each session: systems/minutes.js.
import { readJson } from '../lib/auth.js';
import { appName, isAdmin } from '../lib/config.js';
import { getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { sendPush } from '../lib/push.js';
import { ARABIC_RE, diffDays, escHtml, fail, isDate, json, nowIso, str, todayIn } from '../lib/util.js';
import { route2 } from './assets.js';
import { plusDays } from './docs.js';
import { attendanceStats, handleMinutes } from './minutes.js';
import { checkinCode, checkinUrl } from './checkin.js';

export const MEETING_KINDS = ['committee', 'department', 'special'];
export const CODE_PREFIX = { committee: 'COM', department: 'DEP', special: 'SPM' };
// How often a committee meets. none: a one-off meeting, its sessions are added by hand.
export const FREQUENCIES = { weekly: [7, 0], biweekly: [14, 0], monthly: [0, 1], bimonthly: [0, 2], quarterly: [0, 3], semiannual: [0, 6], annual: [0, 12], none: [0, 0] };
export const MEMBER_ROLES = ['chair', 'co_chair', 'secretary', 'member', 'invitee'];
export const SPECIAL_TYPES = ['urgent', 'rca', 'task_force', 'other'];
export const SESSION_STATUSES = ['scheduled', 'rescheduled', 'postponed', 'cancelled', 'held'];
const RUNS = ['scheduled', 'rescheduled', 'postponed'];
// The schedule reaches a year ahead; the daily job tops it up.
export const HORIZON_DAYS = 365;
// The invitation goes a week before; reminders 3 days and 1 day before.
export const INVITE_DAYS = 7;
const FILE_KINDS = ['tor', 'reference'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Employee numbers typed with Arabic-Indic digits (٢٨٢٤) are the same as 2824.
export const normDigits = (s) => String(s || '').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/* ------------------------------- the schedule ------------------------------ */

const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
// The nth weekday (1-4, or 5 = the last one) of a month.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  let day = 1 + offset + (Math.min(n, 5) - 1) * 7;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  while (day > last) day -= 7;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
// The meeting dates of a committee from its first date up to `until`.
export function scheduleDates(frequency, first, until) {
  const rule = FREQUENCIES[frequency];
  if (!rule || !first || (!rule[0] && !rule[1])) return [];
  const out = [];
  if (rule[0]) {
    for (let d = first; d <= until && out.length < 400; d = plusDays(d, rule[0])) out.push(d);
    return out;
  }
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1;
  const n = Math.ceil(Number(first.slice(8, 10)) / 7);
  const wd = dow(first);
  for (let k = 0; out.length < 400; k += rule[1]) {
    const d = nthWeekday(y + Math.floor((m + k) / 12), (m + k) % 12, wd, n);
    if (d > until) break;
    if (d >= first) out.push(d);
  }
  return out;
}

// Sessions are numbered in date order, so S001 is always the first one.
async function renumber(env, committeeId) {
  const { results } = await env.DB.prepare('SELECT id FROM committee_sessions WHERE committee_id = ? ORDER BY date, start_time, id').bind(committeeId).all();
  if (!results.length) return;
  await env.DB.batch([
    env.DB.prepare('UPDATE committee_sessions SET num = -id WHERE committee_id = ?').bind(committeeId),
    ...results.map((r, i) => env.DB.prepare('UPDATE committee_sessions SET num = ? WHERE id = ?').bind(i + 1, r.id)),
  ]);
}

// Makes the schedule up to a year ahead. Future sessions nobody touched (not moved by hand, not yet sent) are
// made again from the rule, so a change of frequency or time shows at once; the rest stay as they are.
export async function buildSchedule(env, c, today, fresh) {
  if (!c.active || !FREQUENCIES[c.frequency] || c.frequency === 'none' || !c.first_date) return 0;
  const until = plusDays(today, HORIZON_DAYS);
  const stmts = [];
  if (fresh) stmts.push(env.DB.prepare("DELETE FROM committee_sessions WHERE committee_id = ? AND date >= ? AND status = 'scheduled' AND moved = 0 AND kind = 'regular' AND invited_at IS NULL").bind(c.id, today));
  if (stmts.length) await env.DB.batch(stmts);
  const { results: have } = await env.DB.prepare("SELECT date, original_date FROM committee_sessions WHERE committee_id = ? AND kind = 'regular'").bind(c.id).all();
  const taken = new Set(have.flatMap((s) => [s.date, s.original_date]).filter(Boolean));
  const now = nowIso();
  const add = scheduleDates(c.frequency, c.first_date, until).filter((d) => d >= today && !taken.has(d));
  if (!add.length && !fresh) return 0;
  const { n } = await env.DB.prepare('SELECT COALESCE(MAX(num), 0) AS n FROM committee_sessions WHERE committee_id = ?').bind(c.id).first();
  if (add.length)
    await env.DB.batch(
      add.map((d, i) =>
        env.DB.prepare("INSERT INTO committee_sessions (committee_id, num, kind, date, start_time, duration_min, venue, status, created_at, updated_at) VALUES (?, ?, 'regular', ?, ?, ?, ?, 'scheduled', ?, ?)").bind(
          c.id, n + 1000 + i, d, c.start_time, c.duration_min, c.venue, now, now,
        ),
      ),
    );
  await renumber(env, c.id);
  return add.length;
}

/* ------------------------------ notifications ------------------------------ */

const MAIL = {
  ar: {
    dir: 'rtl',
    kind: { invite: 'دعوة لاجتماع', remind3: 'تذكير: الاجتماع بعد 3 أيام', remind1: 'تذكير: الاجتماع غدًا', rescheduled: 'تغيير موعد اجتماع', postponed: 'تأجيل اجتماع', cancelled: 'إلغاء اجتماع' },
    labels: { committee: 'اللجنة', session: 'الجلسة', date: 'التاريخ', time: 'الوقت', venue: 'المكان', reason: 'السبب', was: 'الموعد السابق', tbd: 'يُحدَّد الموعد الجديد لاحقًا' },
    open: 'فتح صفحة اللجنة',
    checkin: 'تسجيل حضوري',
    checkin_note: 'اضغط زر تسجيل الحضور وقت الاجتماع.',
    ics: 'مرفق ملف التقويم لإضافة الموعد إلى تقويمك.',
    footer: (app) => `رسالة تلقائية من نظام اللجان والاجتماعات - ${app}.`,
    days: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  },
  en: {
    dir: 'ltr',
    kind: { invite: 'Meeting invitation', remind3: 'Reminder: meeting in 3 days', remind1: 'Reminder: meeting tomorrow', rescheduled: 'Meeting moved', postponed: 'Meeting postponed', cancelled: 'Meeting cancelled' },
    labels: { committee: 'Committee', session: 'Session', date: 'Date', time: 'Time', venue: 'Venue', reason: 'Reason', was: 'Was', tbd: 'The new date will follow' },
    open: 'Open the committee page',
    checkin: 'Check me in',
    checkin_note: 'Tap the check-in button at the time of the meeting.',
    ics: 'A calendar file is attached to add the meeting to your calendar.',
    footer: (app) => `Automatic message from the committees and meetings system - ${app}.`,
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },
};
export const sessionCode = (c, s) => c.code + '-S' + String(s.num).padStart(3, '0');
const fmtDay = (d, L) => `${L.days[dow(d)]} ${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

// Minutes the time zone is ahead of UTC on that day.
function tzOffset(tz, day) {
  const at = new Date(day + 'T12:00:00Z');
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
    return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - at.getTime()) / 60000;
  } catch {
    return 180;
  }
}
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// A calendar file for the session: added or updated in the member's calendar, or taken off when cancelled.
export function sessionIcs(c, s, settings) {
  const start = Date.parse(`${s.date}T${s.start_time}:00Z`) - tzOffset(settings.timezone || 'Asia/Riyadh', s.date) * 60000;
  let host = 'qms';
  try {
    host = new URL(settings.site_url).hostname;
  } catch {
    /* no site address saved */
  }
  const cancelled = s.status === 'cancelled';
  const name = c.name_en && c.name_en !== c.name_ar ? `${c.name_ar} | ${c.name_en}` : c.name_ar;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//QMS//Committees//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:' + (cancelled ? 'CANCEL' : 'PUBLISH'),
    'BEGIN:VEVENT',
    `UID:committee-session-${s.id}@${host}`,
    'SEQUENCE:' + (s.seq || 0),
    'DTSTAMP:' + icsTime(Date.now()),
    'DTSTART:' + icsTime(start),
    'DTEND:' + icsTime(start + (s.duration_min || 60) * 60000),
    'SUMMARY:' + icsText(`${name} (${sessionCode(c, s)})`),
    s.venue ? 'LOCATION:' + icsText(s.venue) : null,
    settings.site_url ? 'URL:' + settings.site_url + '/#/meetings/committees/' + c.id : null,
    'STATUS:' + (cancelled ? 'CANCELLED' : 'CONFIRMED'),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

// Who is told about a session: the active members and their substitutes (email), and those of them with an
// account here (on their phones).
async function recipients(env, committeeId) {
  const { results } = await env.DB.prepare('SELECT email, substitute_email FROM committee_members WHERE committee_id = ? AND active = 1').bind(committeeId).all();
  const emails = [...new Set(results.flatMap((m) => [m.email, m.substitute_email]).filter((e) => e && e.includes('@')).map((e) => e.toLowerCase()))];
  const users = emails.length
    ? (await env.DB.prepare(`SELECT id FROM users WHERE active = 1 AND lower(email) IN (${emails.map(() => '?').join(',')})`).bind(...emails).all()).results.map((u) => u.id)
    : [];
  return { emails, users };
}

// kind: invite, remind3, remind1, rescheduled, postponed, cancelled. Returns whether the email went out
// (or there was nothing to send), so the caller marks it as sent only then.
export async function notifySession(env, settings, c, s, kind) {
  const { emails, users } = await recipients(env, c.id);
  const withIcs = kind === 'invite' || kind === 'rescheduled' || kind === 'cancelled' || (kind === 'postponed' && !s.date_tbd);
  const link = `${settings.site_url || ''}/#/meetings/committees/${c.id}`;
  // Each member's own check-in link, while the session is still ahead.
  const personal = (kind === 'invite' || kind === 'remind3' || kind === 'remind1' || kind === 'rescheduled') && !s.date_tbd && s.status !== 'cancelled';
  const build = (checkin) => bothLangs(settings, (st) => {
    const L = MAIL[st.email_lang];
    const ar = st.email_lang === 'ar';
    const align = ar ? 'right' : 'left';
    const row = (k, v) => `<tr><td style="padding:6px 10px;color:#6e6553;text-align:${align};white-space:nowrap">${escHtml(L.labels[k])}</td><td style="padding:6px 10px;text-align:${align};font-weight:bold">${escHtml(v)}</td></tr>`;
    const date = s.date_tbd ? L.labels.tbd : fmtDay(s.date, L);
    const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(st)}
      <h2 style="font-size:17px;color:${kind === 'cancelled' ? '#a8443a' : '#1f1a12'}">${escHtml(L.kind[kind])}</h2>
      <table style="border-collapse:collapse;font-size:14px">${[
        row('committee', ar ? c.name_ar : c.name_en || c.name_ar),
        row('session', sessionCode(c, s)),
        row('date', date),
        s.date_tbd ? '' : row('time', s.start_time),
        s.venue ? row('venue', s.venue) : '',
        s.original_date && s.original_date !== s.date && kind !== 'invite' ? row('was', fmtDay(s.original_date, L)) : '',
        s.reason && (kind === 'rescheduled' || kind === 'postponed' || kind === 'cancelled') ? row('reason', s.reason) : '',
      ].join('')}</table>
      ${withIcs ? `<p style="font-size:13px;color:#6e6553">${escHtml(L.ics)}</p>` : ''}
      ${checkin ? `<p style="margin:20px 0 6px"><a href="${escHtml(checkin)}" style="display:inline-block;background:#2f7a4f;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.checkin)}</a></p><p style="font-size:13px;color:#6e6553;margin:0">${escHtml(L.checkin_note)}</p>` : ''}
      <p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
      <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(appName(st, st.email_lang)))}</p></div>`;
    return { subject: `${L.kind[kind]}: ${ar ? c.name_ar : c.name_en || c.name_ar} - ${s.date_tbd ? L.labels.tbd : fmtDay(s.date, L)}`, html };
  });
  let ok = true;
  if (emails.length && mailReady(settings)) {
    const ics = withIcs ? [{ name: 'meeting.ics', type: 'text/calendar', content: btoa(unescape(encodeURIComponent(sessionIcs(c, s, settings)))) }] : null;
    const msgs = [];
    if (personal) {
      // One message per member (and their substitute), each with that member's own link.
      const { results: mem } = await env.DB.prepare('SELECT id, email, substitute_email FROM committee_members WHERE committee_id = ? AND active = 1').bind(c.id).all();
      for (const m of mem) {
        const to = [...new Set([m.email, m.substitute_email].filter((e) => e && e.includes('@')).map((e) => e.toLowerCase()))];
        if (to.length) msgs.push({ to: to.join(','), ...build(checkinUrl(settings, await checkinCode(env, s, m.id))) });
      }
    } else msgs.push({ to: emails.join(','), ...build(null) });
    if (ics) for (const m of msgs) m.attachments = ics;
    const r = await sendMail(settings, msgs);
    ok = r.ok;
  }
  if (users.length)
    await sendPush(env, users, (lang) => {
      const L = MAIL[lang];
      return {
        title: `${L.kind[kind]} - ${lang === 'en' ? c.name_en || c.name_ar : c.name_ar}`,
        body: [s.date_tbd ? L.labels.tbd : fmtDay(s.date, L) + ' ' + s.start_time, s.venue].filter(Boolean).join(' · '),
        url: '/#/meetings/committees/' + c.id,
        tag: 'session-' + s.id,
        urgent: !!c.urgent || kind === 'cancelled',
      };
    }).catch((e) => console.error('push', e));
  return ok;
}

// An invitation sent late (3 days or less before) also counts as the reminders already due.
export async function markInvited(env, id, left) {
  const col = left <= 1 ? 'invited_at = ?1, remind3_at = ?1, remind1_at = ?1' : left <= 3 ? 'invited_at = ?1, remind3_at = ?1' : 'invited_at = ?1';
  await env.DB.prepare(`UPDATE committee_sessions SET ${col} WHERE id = ?2`).bind(nowIso(), id).run();
}

// Daily: top up each schedule, send the week-ahead invitations and the 3-day and 1-day reminders.
export async function runMeetingJobs(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results: list } = await env.DB.prepare(
    `SELECT c.* FROM committees c WHERE c.active = 1 AND c.frequency <> 'none' AND c.first_date IS NOT NULL
      AND COALESCE((SELECT MAX(date) FROM committee_sessions s WHERE s.committee_id = c.id), '') < ?`,
  ).bind(plusDays(today, HORIZON_DAYS - 30)).all();
  let added = 0;
  for (const c of list) added += await buildSchedule(env, c, today, false);
  const { results: due } = await env.DB.prepare(
    `SELECT s.*, c.code, c.name_ar, c.name_en, c.urgent, c.active AS c_active FROM committee_sessions s JOIN committees c ON c.id = s.committee_id
      WHERE c.active = 1 AND s.status IN ('scheduled', 'rescheduled', 'postponed') AND s.date_tbd = 0 AND s.date >= ? AND s.date <= ?
      ORDER BY s.date LIMIT 200`,
  ).bind(today, plusDays(today, INVITE_DAYS)).all();
  const counts = { added, invite: 0, remind3: 0, remind1: 0, failed: 0 };
  for (const s of due) {
    const c = { id: s.committee_id, code: s.code, name_ar: s.name_ar, name_en: s.name_en, urgent: s.urgent };
    const left = diffDays(s.date, today);
    const kind = !s.invited_at ? 'invite' : left <= 1 && !s.remind1_at ? 'remind1' : left <= 3 && left > 1 && !s.remind3_at ? 'remind3' : null;
    if (!kind) continue;
    const ok = await notifySession(env, settings, c, s, kind);
    if (!ok) {
      counts.failed++;
      continue;
    }
    counts[kind]++;
    if (kind === 'invite') await markInvited(env, s.id, left);
    else await env.DB.prepare(`UPDATE committee_sessions SET ${kind === 'remind3' ? 'remind3_at = ?1' : 'remind1_at = ?1, remind3_at = COALESCE(remind3_at, ?1)'} WHERE id = ?2`).bind(nowIso(), s.id).run();
  }
  if (counts.invite + counts.remind3 + counts.remind1 + counts.failed) await logStmt(env, null, counts.failed ? 'remind_failed' : 'remind', 'committee_session', null, null, counts).run();
  return counts;
}

/* --------------------------------- the API -------------------------------- */

function readCommittee(body, kindFixed) {
  const kind = kindFixed || (MEETING_KINDS.includes(body.kind) ? body.kind : 'committee');
  const name_ar = str(body.name_ar, 160);
  const name_en = str(body.name_en, 160);
  if (!name_ar || !name_en) fail(400, 'name_required');
  if (!ARABIC_RE.test(name_ar)) fail(400, 'ar_needs_arabic');
  if (ARABIC_RE.test(name_en)) fail(400, 'name_en_arabic');
  const frequency = kind === 'special' ? 'none' : FREQUENCIES[body.frequency] ? body.frequency : null;
  if (!frequency) fail(400, 'mtg_bad_frequency');
  const first_date = body.first_date ? (isDate(body.first_date) ? body.first_date : fail(400, 'invalid_date')) : null;
  if (frequency !== 'none' && !first_date) fail(400, 'mtg_first_date');
  const start_time = TIME_RE.test(body.start_time || '') ? body.start_time : fail(400, 'mtg_bad_time');
  const duration_min = Math.min(Math.max(Number.parseInt(body.duration_min, 10) || 60, 15), 600);
  const quorum_pct = Math.min(Math.max(Number.parseInt(body.quorum_pct, 10) || 50, 1), 100);
  const department_id = Number.isInteger(Number(body.department_id)) && body.department_id !== null && body.department_id !== '' ? Number(body.department_id) : null;
  if (kind === 'department' && !department_id) fail(400, 'department_required');
  const meeting_type = kind === 'special' ? (SPECIAL_TYPES.includes(body.meeting_type) ? body.meeting_type : 'other') : null;
  return {
    kind,
    name_ar,
    name_en,
    department_id,
    meeting_type,
    urgent: kind === 'special' && (body.urgent === true || body.urgent === 1 || body.meeting_type === 'urgent') ? 1 : 0,
    purpose: str(body.purpose, 2000) || null,
    frequency,
    first_date,
    start_time,
    duration_min,
    venue: str(body.venue, 200) || null,
    quorum_pct,
  };
}
const COMMITTEE_KEYS = ['kind', 'name_ar', 'name_en', 'department_id', 'meeting_type', 'urgent', 'purpose', 'frequency', 'first_date', 'start_time', 'duration_min', 'venue', 'quorum_pct'];

function readMember(body) {
  const name = str(body.name, 120);
  if (!name) fail(400, 'name_required');
  const email = str(body.email, 160).toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email');
  const substitute_email = str(body.substitute_email, 160).toLowerCase() || null;
  if (substitute_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(substitute_email)) fail(400, 'invalid_email');
  const role = MEMBER_ROLES.includes(body.role) ? body.role : 'member';
  return {
    emp_no: normDigits(str(body.emp_no, 30)) || null,
    name,
    name_en: str(body.name_en, 120) || null,
    email,
    position: str(body.position, 120) || null,
    role,
    substitute_name: str(body.substitute_name, 120) || null,
    substitute_email,
  };
}
const MEMBER_KEYS = ['emp_no', 'name', 'name_en', 'email', 'position', 'role', 'substitute_name', 'substitute_email'];
// The order members are listed in: chair, co-chair, secretary, members, invitees.
const ROLE_SORT = Object.fromEntries(MEMBER_ROLES.map((r, i) => [r, i + 1]));

export async function handleMeetings(request, env, url, seg, method, user) {
  const role = user.meetings || 'none';
  if (role === 'none') fail(403, 'forbidden');
  const manager = isAdmin(user) || role === 'manager' || role === 'admin';
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const r2 = route2(method, seg);
  const email = String(user.email || '').toLowerCase();
  // A secretary runs the committees they chair or keep the minutes of, and their own department's meetings.
  const leads = async () =>
    new Set(
      (await env.DB.prepare("SELECT committee_id FROM committee_members WHERE active = 1 AND lower(email) = ? AND role IN ('chair', 'co_chair', 'secretary')").bind(email).all()).results.map((r) => r.committee_id),
    );
  const canRun = (c, lead) => manager || (role === 'secretary' && (lead.has(c.id) || (c.kind === 'department' && user.department_id && c.department_id === user.department_id)));
  const canCreate = (kind, dept) => manager || (role === 'secretary' && kind === 'department' && user.department_id && dept === user.department_id);

  // Every committee with its members count and next session.
  if (r2 === 'GET /committees') {
    const [{ results }, lead, { results: depts }] = await Promise.all([
      env.DB.prepare(
        `SELECT c.*, d.name_ar AS dept_ar, d.name_en AS dept_en,
           (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id = c.id AND m.active = 1) AS members,
           (SELECT name FROM committee_members m WHERE m.committee_id = c.id AND m.active = 1 AND m.role = 'chair' ORDER BY m.id LIMIT 1) AS chair,
           (SELECT s.date || ' ' || s.start_time FROM committee_sessions s WHERE s.committee_id = c.id AND s.status IN ('scheduled', 'rescheduled', 'postponed') AND s.date_tbd = 0 AND s.date >= ?1 ORDER BY s.date, s.start_time LIMIT 1) AS next_at,
           (SELECT COUNT(*) FROM committee_sessions s WHERE s.committee_id = c.id AND s.status = 'held' AND s.date >= ?2) AS held_year,
           (SELECT COUNT(*) FROM committee_sessions s WHERE s.committee_id = c.id AND s.status <> 'cancelled' AND s.date >= ?2 AND s.date < ?1) AS due_year
         FROM committees c LEFT JOIN departments d ON d.id = c.department_id ORDER BY c.active DESC, c.kind, c.code`,
      ).bind(today, today.slice(0, 4) + '-01-01').all(),
      leads(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
    ]);
    return json({
      committees: results.map((c) => ({ ...c, can_run: canRun(c, lead) })),
      departments: depts,
      can_create: manager,
      can_create_dept: manager || (role === 'secretary' && !!user.department_id),
      my_department: user.department_id || null,
      today,
    });
  }

  // Sessions of every committee between two dates, for the calendar.
  if (r2 === 'GET /committees/calendar') {
    const from = isDate(url.searchParams.get('from') || '') ? url.searchParams.get('from') : today.slice(0, 8) + '01';
    const to = isDate(url.searchParams.get('to') || '') ? url.searchParams.get('to') : plusDays(from, 42);
    if (diffDays(to, from) > 100) fail(400, 'invalid_date');
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.committee_id, s.num, s.date, s.start_time, s.duration_min, s.venue, s.status, s.date_tbd, s.kind AS session_kind, c.code, c.kind, c.name_ar, c.name_en, c.urgent
         FROM committee_sessions s JOIN committees c ON c.id = s.committee_id WHERE s.date >= ? AND s.date <= ? AND s.date_tbd = 0 ORDER BY s.date, s.start_time LIMIT 1000`,
    ).bind(from, to).all();
    return json({ sessions: results.map((s) => ({ ...s, session_code: sessionCode(s, s) })), from, to, today });
  }

  // Attendance across committees and meetings over a period, to measure compliance. A secretary sees the
  // ones they run; a viewer or manager sees all. Only held sessions count; late counts as present.
  if (r2 === 'GET /committees/attendance') {
    const from = isDate(url.searchParams.get('from') || '') ? url.searchParams.get('from') : today.slice(0, 4) + '-01-01';
    const to = isDate(url.searchParams.get('to') || '') ? url.searchParams.get('to') : today;
    const lead = await leads();
    const { results: all } = await env.DB.prepare('SELECT c.id, c.code, c.kind, c.name_ar, c.name_en, c.department_id, c.quorum_pct, c.active FROM committees c ORDER BY c.kind, c.code').all();
    const mine = all.filter((c) => role !== 'secretary' || manager || canRun(c, lead));
    const ids = new Set(mine.map((c) => c.id));
    const [{ results: ses }, { results: mem }] = await Promise.all([
      env.DB.prepare(
        `SELECT s.id, s.committee_id, COUNT(a.member_id) AS n, COALESCE(SUM(a.status IN ('present', 'late')), 0) AS p, COALESCE(SUM(a.status = 'absent'), 0) AS ab, COALESCE(SUM(a.status = 'excused'), 0) AS ex
           FROM committee_sessions s LEFT JOIN session_attendance a ON a.session_id = s.id WHERE s.status = 'held' AND s.date >= ? AND s.date <= ? GROUP BY s.id`,
      ).bind(from, to).all(),
      env.DB.prepare(
        `SELECT m.id, m.committee_id, m.name, m.name_en, m.role, COUNT(*) AS n, SUM(a.status IN ('present', 'late')) AS p, SUM(a.status = 'absent') AS ab, SUM(a.status = 'excused') AS ex
           FROM session_attendance a JOIN committee_sessions s ON s.id = a.session_id JOIN committee_members m ON m.id = a.member_id
          WHERE s.status = 'held' AND s.date >= ? AND s.date <= ? GROUP BY m.id`,
      ).bind(from, to).all(),
    ]);
    const pct = (p, n) => (n ? Math.round((100 * p) / n) : null);
    const rows = mine.map((c) => {
      const list = ses.filter((x) => x.committee_id === c.id);
      const marked = list.filter((x) => x.n);
      const n = marked.reduce((a, x) => a + x.n, 0);
      const p = marked.reduce((a, x) => a + x.p, 0);
      return {
        id: c.id, code: c.code, kind: c.kind, name_ar: c.name_ar, name_en: c.name_en, active: c.active,
        held: list.length, recorded: marked.length,
        quorum_met: marked.filter((x) => x.p >= Math.ceil((x.n * c.quorum_pct) / 100)).length,
        absent: marked.reduce((a, x) => a + x.ab, 0), excused: marked.reduce((a, x) => a + x.ex, 0),
        pct: pct(p, n),
      };
    });
    const people = mem.filter((m) => ids.has(m.committee_id)).map((m) => ({ ...m, pct: pct(m.p, m.n) }));
    const tot = rows.reduce((a, r) => ({ n: a.n + r.recorded, q: a.q + r.quorum_met }), { n: 0, q: 0 });
    const allN = people.reduce((a, m) => a + m.n, 0);
    return json({
      from, to, today,
      summary: { committees: rows.filter((r) => r.held).length, held: rows.reduce((a, r) => a + r.held, 0), pct: pct(people.reduce((a, m) => a + m.p, 0), allN), quorum_pct: pct(tot.q, tot.n) },
      committees: rows,
      low: people.filter((m) => m.pct !== null && m.pct < 75).sort((a, b) => a.pct - b.pct).slice(0, 200),
    });
  }

  // Look a person up by employee number (Arabic digits too) or name, to add them as a member.
  if (r2 === 'GET /committees/staff') {
    const q = normDigits(str(url.searchParams.get('q') || '', 60));
    const dept = Number(url.searchParams.get('department_id')) || null;
    if (!q && !dept) return json({ staff: [] });
    const { results } = q
      ? await env.DB.prepare(
          `SELECT s.emp_no, s.name, s.name_en, s.department_id, d.name_ar AS dept_ar, d.name_en AS dept_en FROM staff s LEFT JOIN departments d ON d.id = s.department_id
            WHERE s.active = 1 AND (s.emp_no = ?1 OR s.name LIKE ?2 OR s.name_en LIKE ?2) ORDER BY s.emp_no = ?1 DESC, s.name LIMIT 10`,
        ).bind(q, '%' + q + '%').all()
      : await env.DB.prepare(
          `SELECT s.emp_no, s.name, s.name_en, s.department_id, d.name_ar AS dept_ar, d.name_en AS dept_en FROM staff s LEFT JOIN departments d ON d.id = s.department_id
            WHERE s.active = 1 AND s.department_id = ? ORDER BY s.name LIMIT 200`,
        ).bind(dept).all();
    return json({ staff: results });
  }

  if (r2 === 'POST /committees') {
    const body = await readJson(request);
    const d = readCommittee(body);
    if (!canCreate(d.kind, d.department_id)) fail(403, 'forbidden');
    if (d.department_id && !(await env.DB.prepare('SELECT 1 FROM departments WHERE id = ?').bind(d.department_id).first())) fail(400, 'department_required');
    const prefix = CODE_PREFIX[d.kind];
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM committees WHERE kind = ?").bind(d.kind).first();
    let code = prefix + '-' + String(n + 1).padStart(3, '0');
    for (let i = 2; await env.DB.prepare('SELECT 1 FROM committees WHERE code = ?').bind(code).first(); i++) code = prefix + '-' + String(n + i).padStart(3, '0');
    const now = nowIso();
    const res = await env.DB.prepare(`INSERT INTO committees (code, ${COMMITTEE_KEYS.join(', ')}, active, created_at, updated_at) VALUES (?, ${COMMITTEE_KEYS.map(() => '?').join(', ')}, 1, ?, ?)`)
      .bind(code, ...COMMITTEE_KEYS.map((k) => d[k]), now, now)
      .run();
    const id = res.meta.last_row_id;
    await logStmt(env, user, 'create', 'committee', id, code + ' ' + d.name_ar).run();
    // A one-off meeting has its one session at once.
    if (d.kind === 'special' && d.first_date) {
      await env.DB.prepare("INSERT INTO committee_sessions (committee_id, num, kind, date, start_time, duration_min, venue, status, created_at, updated_at) VALUES (?, 1, 'regular', ?, ?, ?, ?, 'scheduled', ?, ?)")
        .bind(id, d.first_date, d.start_time, d.duration_min, d.venue, now, now)
        .run();
    } else await buildSchedule(env, { id, ...d, active: 1 }, today, true);
    return json({ ok: true, id, code });
  }

  // Changing a session: move it, postpone it (with or without a new date) or cancel it, always with a reason.
  // The members are told at once, with an updated calendar file.
  if (seg[0] === 'committee-sessions' && /^\d+$/.test(seg[1] || '')) {
    const s = await env.DB.prepare('SELECT * FROM committee_sessions WHERE id = ?').bind(Number(seg[1])).first();
    if (!s) fail(404, 'not_found');
    const c = await env.DB.prepare('SELECT * FROM committees WHERE id = ?').bind(s.committee_id).first();
    if (method === 'GET' && seg[2] === 'ics' && seg.length === 3) {
      return new Response(sessionIcs(c, s, settings), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${sessionCode(c, s)}.ics"`, 'cache-control': 'no-store' } });
    }
    // The session's QR code for checking in (shown on the screen or printed in the room).
    if (method === 'GET' && seg[2] === 'checkin' && seg.length === 3) {
      if (!canRun(c, await leads())) fail(403, 'forbidden');
      return json({ code: await checkinCode(env, s, 'q') });
    }
    if (seg[2] === 'minutes') {
      const lead = await leads();
      return handleMinutes(request, env, method, seg, { user, c, s, run: canRun(c, lead), manager, today, lead, code: sessionCode(c, s), tz: settings.timezone });
    }
    if (method !== 'PUT' || seg.length !== 2) fail(405, 'method_not_allowed');
    if (!canRun(c, await leads())) fail(403, 'forbidden');
    const body = await readJson(request);
    const action = ['reschedule', 'postpone', 'cancel', 'held', 'restore'].includes(body.action) ? body.action : fail(400, 'mtg_bad_action');
    if (s.status === 'cancelled' && action !== 'restore') fail(409, 'mtg_session_closed');
    if (s.status === 'held' && action !== 'restore') fail(409, 'mtg_session_closed');
    const reason = str(body.reason, 500) || null;
    if ((action === 'reschedule' || action === 'postpone' || action === 'cancel') && !reason) fail(400, 'mtg_reason_required');
    const next = { date: s.date, start_time: s.start_time, venue: s.venue, status: s.status, date_tbd: s.date_tbd, reason: s.reason };
    if (action === 'reschedule' || action === 'postpone') {
      const date = body.date ? (isDate(body.date) ? body.date : fail(400, 'invalid_date')) : null;
      if (action === 'reschedule' && !date) fail(400, 'invalid_date');
      if (date && date < today) fail(400, 'mtg_past_date');
      if (action === 'postpone' && date && date <= s.date) fail(400, 'mtg_postpone_later');
      next.date = date || s.date;
      next.date_tbd = date ? 0 : 1;
      next.start_time = TIME_RE.test(body.start_time || '') ? body.start_time : s.start_time;
      next.venue = body.venue !== undefined ? str(body.venue, 200) || null : s.venue;
      next.status = action === 'reschedule' ? 'rescheduled' : 'postponed';
      next.reason = reason;
    } else if (action === 'cancel') {
      next.status = 'cancelled';
      next.reason = reason;
    } else if (action === 'held') {
      if (s.date > today) fail(400, 'mtg_not_yet');
      next.status = 'held';
    } else {
      if (s.date < today) fail(400, 'mtg_past_date');
      next.status = s.status === 'held' ? 'scheduled' : 'rescheduled';
      next.reason = null;
    }
    const tell = action === 'reschedule' || action === 'postpone' || action === 'cancel' || (action === 'restore' && s.status === 'cancelled');
    const now = nowIso();
    const moved = { ...s, ...next, seq: s.seq + (tell ? 1 : 0), original_date: s.original_date || s.date };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE committee_sessions SET date = ?, start_time = ?, venue = ?, status = ?, date_tbd = ?, reason = ?, moved = 1, seq = ?, original_date = ?,
           remind3_at = CASE WHEN ? THEN NULL ELSE remind3_at END, remind1_at = CASE WHEN ? THEN NULL ELSE remind1_at END, updated_at = ? WHERE id = ?`,
      ).bind(next.date, next.start_time, next.venue, next.status, next.date_tbd, next.reason, moved.seq, moved.original_date, tell ? 1 : 0, tell ? 1 : 0, now, s.id),
      logStmt(env, user, action, 'committee_session', s.id, sessionCode(c, s), { status: [s.status, next.status], date: [s.date, next.date], reason: [s.reason, next.reason] }),
    ]);
    if (next.date !== s.date) await renumber(env, c.id);
    let notified = null;
    // The members already knew of it (invited) or it is within the invitation week: tell them now.
    if (tell && (s.invited_at || diffDays(next.date, today) <= INVITE_DAYS || action === 'cancel')) {
      const fresh = await env.DB.prepare('SELECT * FROM committee_sessions WHERE id = ?').bind(s.id).first();
      const kind = action === 'restore' ? 'invite' : next.status;
      notified = await notifySession(env, settings, c, fresh, kind);
      if (notified && kind !== 'cancelled' && !fresh.date_tbd) await markInvited(env, s.id, diffDays(fresh.date, today));
    }
    return json({ ok: true, notified });
  }

  if (seg[0] !== 'committees' || !/^\d+$/.test(seg[1] || '')) return null;
  const id = Number(seg[1]);
  const c = await env.DB.prepare('SELECT c.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM committees c LEFT JOIN departments d ON d.id = c.department_id WHERE c.id = ?').bind(id).first();
  if (!c) fail(404, 'not_found');
  const lead = await leads();
  const run = canRun(c, lead);
  const needRun = () => {
    if (!run) fail(403, 'forbidden');
  };

  // One committee: its details, members, papers and sessions.
  if (method === 'GET' && seg.length === 2) {
    const [{ results: members }, { results: files }, { results: sessions }] = await Promise.all([
      env.DB.prepare('SELECT * FROM committee_members WHERE committee_id = ? ORDER BY active DESC, sort, id').bind(id).all(),
      env.DB.prepare('SELECT id, kind, name, content_type, size, uploaded_by, created_at FROM committee_files WHERE committee_id = ? ORDER BY kind DESC, id').bind(id).all(),
      env.DB.prepare('SELECT * FROM committee_sessions WHERE committee_id = ? ORDER BY date, start_time').bind(id).all(),
    ]);
    const active = members.filter((m) => m.active && m.role !== 'invitee').length;
    const stats = await attendanceStats(env, id);
    return json({
      committee: { ...c, quorum_n: Math.ceil((active * c.quorum_pct) / 100) },
      members: members.map((m) => ({ ...m, attendance: stats[m.id] || null })),
      files,
      sessions: sessions.map((s) => ({ ...s, code: sessionCode(c, s) })),
      can_run: run,
      can_manage: manager,
      today,
    });
  }

  if (method === 'PUT' && seg.length === 2) {
    needRun();
    const body = await readJson(request);
    const d = readCommittee(body, c.kind);
    if (c.kind === 'department' && !manager && d.department_id !== c.department_id) fail(403, 'forbidden');
    const active = body.active === false ? 0 : 1;
    const ruleChanged = ['frequency', 'first_date', 'start_time', 'duration_min', 'venue'].some((k) => d[k] !== c[k]) || active !== c.active;
    await env.DB.batch([
      env.DB.prepare(`UPDATE committees SET ${COMMITTEE_KEYS.map((k) => k + ' = ?').join(', ')}, active = ?, updated_at = ? WHERE id = ?`).bind(...COMMITTEE_KEYS.map((k) => d[k]), active, nowIso(), id),
      logStmt(env, user, 'update', 'committee', id, c.code + ' ' + d.name_ar, Object.fromEntries([...COMMITTEE_KEYS, 'active'].filter((k) => (k === 'active' ? active : d[k]) !== c[k]).map((k) => [k, [c[k], k === 'active' ? active : d[k]]]))),
    ]);
    // A switched-off committee keeps its past; its future untouched sessions go.
    if (!active) await env.DB.prepare("DELETE FROM committee_sessions WHERE committee_id = ? AND date >= ? AND status = 'scheduled' AND moved = 0 AND invited_at IS NULL").bind(id, today).run();
    else if (ruleChanged && c.kind !== 'special') await buildSchedule(env, { id, ...d, active }, today, true);
    return json({ ok: true });
  }

  // Deleting a committee is only for one with nothing held; otherwise it is switched off.
  if (method === 'DELETE' && seg.length === 2) {
    if (!manager) fail(403, 'forbidden');
    const held = await env.DB.prepare("SELECT COUNT(*) AS n FROM committee_sessions WHERE committee_id = ? AND (status = 'held' OR invited_at IS NOT NULL)").bind(id).first();
    if (held.n) {
      await env.DB.batch([
        env.DB.prepare('UPDATE committees SET active = 0, updated_at = ? WHERE id = ?').bind(nowIso(), id),
        env.DB.prepare("DELETE FROM committee_sessions WHERE committee_id = ? AND date >= ? AND status = 'scheduled' AND invited_at IS NULL").bind(id, today),
        logStmt(env, user, 'retire', 'committee', id, c.code),
      ]);
      return json({ ok: true, retired: true });
    }
    const { results: files } = await env.DB.prepare('SELECT file_key FROM committee_files WHERE committee_id = ?').bind(id).all();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM committee_sessions WHERE committee_id = ?').bind(id),
      env.DB.prepare('DELETE FROM committee_members WHERE committee_id = ?').bind(id),
      env.DB.prepare('DELETE FROM committee_files WHERE committee_id = ?').bind(id),
      env.DB.prepare('DELETE FROM committees WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'committee', id, c.code),
    ]);
    for (const f of files) await env.FILES.delete(f.file_key);
    return json({ ok: true, retired: false });
  }

  // An extra session: an extraordinary meeting of the committee, or another session of a special meeting.
  if (method === 'POST' && seg[2] === 'sessions' && seg.length === 3) {
    needRun();
    const body = await readJson(request);
    const date = isDate(body.date || '') ? body.date : fail(400, 'invalid_date');
    if (date < today) fail(400, 'mtg_past_date');
    const start_time = TIME_RE.test(body.start_time || '') ? body.start_time : c.start_time;
    const reason = str(body.reason, 500) || null;
    const now = nowIso();
    const res = await env.DB.prepare("INSERT INTO committee_sessions (committee_id, num, kind, date, start_time, duration_min, venue, status, moved, reason, created_at, updated_at) VALUES (?, ?, 'extraordinary', ?, ?, ?, ?, 'scheduled', 1, ?, ?, ?)")
      .bind(id, 100000 + Math.floor(Math.random() * 100000), date, start_time, c.duration_min, str(body.venue, 200) || c.venue, reason, now, now)
      .run();
    await renumber(env, id);
    const s = await env.DB.prepare('SELECT * FROM committee_sessions WHERE id = ?').bind(res.meta.last_row_id).first();
    await logStmt(env, user, 'create', 'committee_session', s.id, sessionCode(c, s), { kind: [null, 'extraordinary'], date: [null, date] }).run();
    // Inside the invitation week, or an urgent meeting: invite now.
    let notified = null;
    if (c.urgent || diffDays(date, today) <= INVITE_DAYS) {
      notified = await notifySession(env, settings, c, s, 'invite');
      if (notified) await markInvited(env, s.id, diffDays(date, today));
    }
    return json({ ok: true, id: s.id, notified });
  }

  // Send the invitation of a session now (for a meeting called at short notice, or a member added late).
  if (method === 'POST' && seg[2] === 'sessions' && /^\d+$/.test(seg[3] || '') && seg[4] === 'invite' && seg.length === 5) {
    needRun();
    const s = await env.DB.prepare('SELECT * FROM committee_sessions WHERE id = ? AND committee_id = ?').bind(Number(seg[3]), id).first();
    if (!s) fail(404, 'not_found');
    if (!RUNS.includes(s.status) || s.date_tbd || s.date < today) fail(409, 'mtg_session_closed');
    const ok = await notifySession(env, settings, c, s, 'invite');
    if (ok) await markInvited(env, s.id, diffDays(s.date, today));
    await logStmt(env, user, ok ? 'invite' : 'invite_failed', 'committee_session', s.id, sessionCode(c, s)).run();
    return json({ ok: true, notified: ok });
  }

  // Members.
  if (method === 'POST' && seg[2] === 'members' && seg.length === 3) {
    needRun();
    const d = readMember(await readJson(request));
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM committee_members WHERE committee_id = ?').bind(id).first();
    if (n.n >= 200) fail(409, 'mtg_too_many');
    if (d.emp_no && (await env.DB.prepare('SELECT 1 FROM committee_members WHERE committee_id = ? AND emp_no = ? AND active = 1').bind(id, d.emp_no).first())) fail(409, 'mtg_member_taken');
    const res = await env.DB.prepare(`INSERT INTO committee_members (committee_id, ${MEMBER_KEYS.join(', ')}, sort, active, created_at) VALUES (?, ${MEMBER_KEYS.map(() => '?').join(', ')}, ?, 1, ?)`)
      .bind(id, ...MEMBER_KEYS.map((k) => d[k]), ROLE_SORT[d.role], nowIso())
      .run();
    await logStmt(env, user, 'create', 'committee_member', res.meta.last_row_id, c.code + ' ' + d.name, { role: [null, d.role] }).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if (seg[2] === 'members' && /^\d+$/.test(seg[3] || '') && seg.length === 4) {
    needRun();
    const m = await env.DB.prepare('SELECT * FROM committee_members WHERE id = ? AND committee_id = ?').bind(Number(seg[3]), id).first();
    if (!m) fail(404, 'not_found');
    if (method === 'PUT') {
      const body = await readJson(request);
      const d = readMember({ ...m, ...body });
      const active = body.active === false ? 0 : 1;
      // Switching a member off needs a reason, so the chair knows why they no longer come.
      const inactive_reason = active ? null : str(body.inactive_reason, 300) || (m.active ? fail(400, 'mtg_reason_required') : m.inactive_reason);
      await env.DB.batch([
        env.DB.prepare(`UPDATE committee_members SET ${MEMBER_KEYS.map((k) => k + ' = ?').join(', ')}, sort = ?, active = ?, inactive_reason = ?, inactive_at = ? WHERE id = ?`).bind(
          ...MEMBER_KEYS.map((k) => d[k]), ROLE_SORT[d.role], active, inactive_reason, active ? null : m.active ? nowIso() : m.inactive_at, m.id,
        ),
        logStmt(env, user, active === m.active ? 'update' : active ? 'activate' : 'deactivate', 'committee_member', m.id, c.code + ' ' + d.name, {
          ...Object.fromEntries(MEMBER_KEYS.filter((k) => d[k] !== m[k]).map((k) => [k, [m[k], d[k]]])),
          ...(active !== m.active ? { active: [m.active, active], inactive_reason: [m.inactive_reason, inactive_reason] } : {}),
        }),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM committee_members WHERE id = ?').bind(m.id), logStmt(env, user, 'delete', 'committee_member', m.id, c.code + ' ' + m.name)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  // Terms of reference and reference papers.
  if (method === 'POST' && seg[2] === 'files' && seg.length === 3) {
    needRun();
    const form = await request.formData().catch(() => fail(400, 'bad_request'));
    const file = form.get('file');
    if (!file || typeof file === 'string' || !file.size) fail(400, 'mtg_file_required');
    if (file.size > MAX_FILE_BYTES) fail(413, 'file_too_large');
    const ext = String(file.name || '').split('.').pop().toLowerCase();
    const type = FILE_TYPES[ext];
    if (!type) fail(400, 'mtg_file_type');
    const kind = FILE_KINDS.includes(form.get('kind')) ? form.get('kind') : 'reference';
    const name = str(form.get('name'), 160) || str(file.name, 160);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM committee_files WHERE committee_id = ?').bind(id).first();
    if (count.n >= 50) fail(409, 'too_many_docs');
    const key = `committees/${id}/${crypto.randomUUID()}.${ext}`;
    await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type } });
    try {
      const res = await env.DB.prepare('INSERT INTO committee_files (committee_id, kind, name, file_key, content_type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, kind, name, key, type, file.size, user.name, nowIso())
        .run();
      await logStmt(env, user, 'create', 'committee_file', res.meta.last_row_id, c.code + ' ' + name, { kind: [null, kind] }).run();
      return json({ ok: true, id: res.meta.last_row_id });
    } catch (e) {
      await env.FILES.delete(key);
      throw e;
    }
  }
  if (seg[2] === 'files' && /^\d+$/.test(seg[3] || '') && seg.length === 4) {
    const f = await env.DB.prepare('SELECT * FROM committee_files WHERE id = ? AND committee_id = ?').bind(Number(seg[3]), id).first();
    if (!f) fail(404, 'not_found');
    if (method === 'GET') {
      const obj = await env.FILES.get(f.file_key);
      if (!obj) fail(404, 'not_found');
      const ext = f.file_key.split('.').pop();
      const inline = ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg';
      const fname = encodeURIComponent((f.name.toLowerCase().endsWith('.' + ext) ? f.name : f.name + '.' + ext).replace(/[\r\n"]/g, ''));
      return new Response(obj.body, {
        headers: { 'content-type': f.content_type || 'application/octet-stream', 'content-length': String(obj.size), 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${fname}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    if (method === 'DELETE') {
      needRun();
      await env.DB.batch([env.DB.prepare('DELETE FROM committee_files WHERE id = ?').bind(f.id), logStmt(env, user, 'delete', 'committee_file', f.id, c.code + ' ' + f.name)]);
      await env.FILES.delete(f.file_key);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }
  fail(404, 'not_found');
}

// The home page card and list: upcoming sessions in the next 30 days, sessions past their date that were
// not marked held, and the next five sessions. People without a committees role see only the committees
// they sit on (matched by email, as a member or a substitute).
export async function meetingsHome(env, user, today) {
  const role = user.meetings && user.meetings !== 'none';
  const email = String(user.email || '').toLowerCase();
  if (!role && !email) return null;
  const mine = `c.id IN (SELECT committee_id FROM committee_members WHERE active = 1 AND (lower(email) = ?3 OR lower(substitute_email) = ?3))`;
  const where = `c.active = 1 AND s.status IN ('scheduled','rescheduled') AND s.date_tbd = 0` + (role ? '' : ' AND ' + mine);
  const counts = await env.DB.prepare(
    `SELECT SUM(s.date >= ?1 AND s.date <= ?2) AS upcoming, SUM(s.date < ?1) AS late, SUM(s.date = ?1) AS today
       FROM committee_sessions s JOIN committees c ON c.id = s.committee_id WHERE ${where} AND (?3 IS NOT NULL)`,
  )
    .bind(today, new Date(Date.parse(today + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10), email)
    .first();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.date, s.start_time, s.status, s.committee_id, c.code, c.kind, c.name_ar, c.name_en, COALESCE(s.venue, c.venue) AS venue, s.num
       FROM committee_sessions s JOIN committees c ON c.id = s.committee_id
      WHERE ${where} AND s.date >= ?1 AND (?3 IS NOT NULL) ORDER BY s.date, s.start_time LIMIT 5`,
  )
    .bind(today, null, email)
    .all();
  if (!role && !results.length && !counts.upcoming) return null;
  return { upcoming: counts.upcoming || 0, late: role ? counts.late || 0 : 0, today: counts.today || 0, next: results.map((s) => ({ ...s, code: sessionCode(s, s) })) };
}

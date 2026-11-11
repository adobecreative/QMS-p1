// Electronic attendance at a committee or meeting session, with no account needed.
// Each member gets a personal link in the invitation and reminder emails; one tap marks them present.
// Each session also has a QR code (shown on the screen or printed in the room): whoever scans it gives their
// employee number or email, and only a member of that committee is accepted.
// Links work from 30 minutes before the start until 30 minutes after the end; after 10 minutes from the start
// the member is marked late. Approved minutes are never changed. Unmarked members are absent in the minutes.
import { readJson } from '../lib/auth.js';
import { getSettings, logStmt } from '../lib/db.js';
import { fail, json, nowIso, sha256Hex, str, toHex } from '../lib/util.js';

const OPEN_BEFORE = 30;
const CLOSE_AFTER = 30;
const LATE_AFTER = 10;
export const CODE_RE = /^(\d+)\.(q|\d+)\.([0-9a-f]{24})$/;

// The session's secret, made the first time a link is needed.
export async function checkinKey(env, s) {
  if (s.checkin_key) return s.checkin_key;
  const key = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('UPDATE committee_sessions SET checkin_key = ? WHERE id = ? AND checkin_key IS NULL').bind(key, s.id).run();
  return (await env.DB.prepare('SELECT checkin_key FROM committee_sessions WHERE id = ?').bind(s.id).first()).checkin_key;
}
const tokenFor = async (key, who) => (await sha256Hex(key + ':' + who)).slice(0, 24);
// who: a member id, or 'q' for the session's QR code.
export async function checkinCode(env, s, who) {
  return `${s.id}.${who}.${await tokenFor(await checkinKey(env, s), who)}`;
}
export const checkinUrl = (settings, code) => `${settings.site_url || ''}/#/checkin/${code}`;

// Minutes since midnight now and the date, in the hospital's time zone.
function nowIn(tz) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  } catch {
    const d = new Date();
    return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
// before | open | late | closed, for a session now. A session runs within one day.
export function sessionPhase(s, tz) {
  const now = nowIn(tz);
  if (now.date < s.date) return 'before';
  if (now.date > s.date) return 'closed';
  const start = toMin(s.start_time);
  if (now.min < start - OPEN_BEFORE) return 'before';
  if (now.min > start + (s.duration_min || 60) + CLOSE_AFTER) return 'closed';
  return now.min > start + LATE_AFTER ? 'late' : 'open';
}
// Whether the session is over (its end has passed), for marking the rest absent in the minutes.
export function sessionEnded(s, tz) {
  const now = nowIn(tz);
  if (now.date !== s.date) return now.date > s.date;
  return now.min > toMin(s.start_time) + (s.duration_min || 60);
}

const digits = (v) => String(v || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).trim();

// /api/checkin/:code (GET: what the page shows; POST: mark present). No account needed.
export async function handleCheckin(request, env, method, code) {
  const m = CODE_RE.exec(code || '');
  if (!m) fail(404, 'checkin_invalid');
  const s = await env.DB.prepare('SELECT * FROM committee_sessions WHERE id = ?').bind(Number(m[1])).first();
  if (!s || !s.checkin_key || (await tokenFor(s.checkin_key, m[2])) !== m[3]) fail(404, 'checkin_invalid');
  const c = await env.DB.prepare('SELECT id, code, name_ar, name_en FROM committees WHERE id = ?').bind(s.committee_id).first();
  const settings = await getSettings(env);
  const phase = s.status === 'cancelled' || s.date_tbd ? 'closed' : sessionPhase(s, settings.timezone);
  const qr = m[2] === 'q';
  const personal = qr ? null : await env.DB.prepare('SELECT id, name, name_en, active FROM committee_members WHERE id = ? AND committee_id = ?').bind(Number(m[2]), c.id).first();
  if (!qr && (!personal || !personal.active)) fail(404, 'checkin_invalid');
  const info = { committee: { name_ar: c.name_ar, name_en: c.name_en }, session: { date: s.date, start_time: s.start_time, venue: s.venue }, phase, qr };
  const already = async (id) => env.DB.prepare('SELECT status, checked_at FROM session_attendance WHERE session_id = ? AND member_id = ?').bind(s.id, id).first();

  if (method === 'GET') {
    const mine = personal ? await already(personal.id) : null;
    return json({ ...info, member: personal ? { name: personal.name, name_en: personal.name_en } : null, marked: mine ? mine.status : null });
  }
  if (method !== 'POST') fail(405, 'method_not_allowed');
  if (phase === 'before') fail(409, 'checkin_not_open');
  if (phase === 'closed') fail(409, 'checkin_closed');
  if (s.minutes_status === 'approved') fail(409, 'checkin_closed');
  let member = personal;
  if (qr) {
    const body = await readJson(request);
    const who = digits(str(body.who, 200)).toLowerCase();
    if (!who) fail(400, 'checkin_who');
    member = await env.DB.prepare('SELECT id, name, name_en FROM committee_members WHERE committee_id = ? AND active = 1 AND (lower(email) = ? OR emp_no = ?) LIMIT 1').bind(c.id, who, who).first();
    if (!member) fail(404, 'checkin_not_member');
  }
  const prev = await already(member.id);
  if (prev) return json({ ok: true, status: prev.status, name: member.name, name_en: member.name_en, again: true });
  const status = phase === 'late' ? 'late' : 'present';
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO session_attendance (session_id, member_id, status, checked_at, method) VALUES (?, ?, ?, ?, ?)').bind(s.id, member.id, status, nowIso(), qr ? 'qr' : 'link'),
    logStmt(env, { id: null, name: member.name }, 'checkin', 'committee_session', s.id, c.code, { status: [null, status] }),
  ]);
  return json({ ok: true, status, name: member.name, name_en: member.name_en });
}

// Minutes and attendance of a committee session (committees, department meetings and special meetings alike).
// Who may write: whoever runs the committee (its secretary, chair or co-chair, the head of the department for a
// department meeting, or a committees manager). Draft -> pending (sent to the chair) -> approved, then locked.
// Who approves: the chair or co-chair, the head of the department for a department meeting, or a manager.
// An action still open at the last session with minutes is carried into a new session's minutes.
import { readJson } from '../lib/auth.js';
import { logStmt } from '../lib/db.js';
import { fail, isDate, json, nowIso, str } from '../lib/util.js';
import { sessionEnded } from './checkin.js';
import { absenceReports } from './ovr.js';

export const ATTENDANCE = ['present', 'late', 'absent', 'excused'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Attendance of each member over the held sessions of one committee: { member_id: { n, present, absent, excused, pct } }.
// pct counts late as present; an excused absence still counts as missed.
export async function attendanceStats(env, committeeId) {
  const { results } = await env.DB.prepare(
    `SELECT a.member_id, COUNT(*) AS n, SUM(a.status IN ('present', 'late')) AS present, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused
       FROM session_attendance a JOIN committee_sessions s ON s.id = a.session_id
      WHERE s.committee_id = ? AND s.status = 'held' GROUP BY a.member_id`,
  )
    .bind(committeeId)
    .all();
  const out = {};
  for (const r of results) out[r.member_id] = { n: r.n, present: r.present, absent: r.absent, excused: r.excused, pct: r.n ? Math.round((100 * r.present) / r.n) : null };
  return out;
}

// /api/committee-sessions/:id/minutes (GET, PUT) and /approve, /reopen (POST).
export async function handleMinutes(request, env, method, seg, ctx) {
  const { user, c, s, run, manager, today, lead } = ctx;
  const email = String(user.email || '').toLowerCase();
  const chairOf = !!(await env.DB.prepare("SELECT 1 AS x FROM committee_members WHERE committee_id = ? AND active = 1 AND lower(email) = ? AND role IN ('chair', 'co_chair')").bind(c.id, email).first());
  const deptHead = c.kind === 'department' && run && !lead.has(c.id) && !manager;
  const canApprove = manager || chairOf || deptHead;
  const status = s.minutes_status || 'draft';
  const code = ctx.code;

  if (method === 'GET' && seg.length === 3) {
    const [{ results: members }, { results: att }, { results: items }] = await Promise.all([
      env.DB.prepare('SELECT id, name, name_en, position, role, active, emp_no FROM committee_members WHERE committee_id = ? ORDER BY sort, id').bind(c.id).all(),
      env.DB.prepare('SELECT member_id, status, note, checked_at, method FROM session_attendance WHERE session_id = ?').bind(s.id).all(),
      env.DB.prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY sn, id').bind(s.id).all(),
    ]);
    const marked = new Set(att.map((a) => a.member_id));
    // The members of the session: those active now, and anyone already marked (switched off since).
    const list = members.filter((m) => m.active || marked.has(m.id));
    // A new minutes starts with the actions still open from the last session that has minutes.
    let carry = [];
    if (!items.length && status === 'draft') {
      const prev = await env.DB.prepare(
        "SELECT id FROM committee_sessions WHERE committee_id = ? AND id <> ? AND minutes_status IS NOT NULL AND (date < ? OR (date = ? AND start_time < ?)) ORDER BY date DESC, start_time DESC LIMIT 1",
      )
        .bind(c.id, s.id, s.date, s.date, s.start_time)
        .first();
      if (prev) carry = (await env.DB.prepare("SELECT * FROM session_items WHERE session_id = ? AND status = 'open' AND action IS NOT NULL AND action <> '' ORDER BY sn, id").bind(prev.id).all()).results;
    }
    return json({
      committee: { id: c.id, code: c.code, kind: c.kind, name_ar: c.name_ar, name_en: c.name_en, quorum_pct: c.quorum_pct },
      session: { ...s, code, minutes_status: status },
      members: list,
      attendance: att,
      items,
      carry: carry.map((i) => ({ subject: i.subject, discussion: i.discussion, action: i.action, responsibility: i.responsibility, target_date: i.target_date, status: 'open', carried_from: i.id })),
      // Once the session is over, whoever did not check in shows as absent until the minutes are saved.
      ended: sessionEnded(s, ctx.tz),
      can_edit: run && status !== 'approved' && s.status !== 'cancelled' && s.date <= today,
      can_approve: canApprove && status === 'pending',
      can_reopen: manager && status === 'approved',
    });
  }

  if (method === 'PUT' && seg.length === 3) {
    if (!run) fail(403, 'forbidden');
    if (status === 'approved') fail(409, 'mtg_minutes_locked');
    if (s.status === 'cancelled') fail(409, 'mtg_session_closed');
    if (s.date > today) fail(400, 'mtg_not_yet');
    const body = await readJson(request);
    const submit = body.submit === true;
    const { results: members } = await env.DB.prepare('SELECT id FROM committee_members WHERE committee_id = ?').bind(c.id).all();
    const ids = new Set(members.map((m) => m.id));
    const att = (Array.isArray(body.attendance) ? body.attendance : [])
      .filter((a) => a && ids.has(Number(a.member_id)) && ATTENDANCE.includes(a.status))
      .map((a) => ({ member_id: Number(a.member_id), status: a.status, note: str(a.note, 200) || null }));
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map((i) => ({
      subject: str(i && i.subject, 300),
      discussion: str(i && i.discussion, 4000) || null,
      action: str(i && i.action, 1000) || null,
      responsibility: str(i && i.responsibility, 200) || null,
      target_date: i && i.target_date ? (isDate(i.target_date) ? i.target_date : fail(400, 'invalid_date')) : null,
      status: i && i.status === 'closed' ? 'closed' : 'open',
      carried_from: i && Number.isInteger(Number(i.carried_from)) && i.carried_from ? Number(i.carried_from) : null,
    }));
    if (items.some((i) => !i.subject)) fail(400, 'mtg_item_subject');
    const time_started = TIME_RE.test(body.time_started || '') ? body.time_started : null;
    if (submit) {
      // Sent to the chair only when complete: every active member marked, and at least one line.
      const { results: active } = await env.DB.prepare('SELECT id FROM committee_members WHERE committee_id = ? AND active = 1').bind(c.id).all();
      const have = new Set(att.map((a) => a.member_id));
      if (active.some((m) => !have.has(m.id))) fail(400, 'mtg_attendance_missing');
      if (!items.length) fail(400, 'mtg_items_missing');
    }
    // Who checked in themselves keeps when and how.
    const { results: selfIn } = await env.DB.prepare('SELECT member_id, checked_at, method FROM session_attendance WHERE session_id = ? AND method IS NOT NULL').bind(s.id).all();
    const kept = Object.fromEntries(selfIn.map((r) => [r.member_id, r]));
    const now = nowIso();
    const next = submit ? 'pending' : 'draft';
    const who = user.name_en || user.name;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM session_attendance WHERE session_id = ?').bind(s.id),
      env.DB.prepare('DELETE FROM session_items WHERE session_id = ?').bind(s.id),
      ...att.map((a) => env.DB.prepare('INSERT INTO session_attendance (session_id, member_id, status, note, checked_at, method) VALUES (?, ?, ?, ?, ?, ?)').bind(s.id, a.member_id, a.status, a.note, kept[a.member_id]?.checked_at || null, kept[a.member_id]?.method || null)),
      ...items.map((i, n) =>
        env.DB.prepare('INSERT INTO session_items (session_id, sn, subject, discussion, action, responsibility, target_date, status, carried_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
          s.id, n + 1, i.subject, i.discussion, i.action, i.responsibility, i.target_date, i.status, i.carried_from, now,
        ),
      ),
      // Writing the minutes means the session took place.
      env.DB.prepare("UPDATE committee_sessions SET minutes_status = ?, time_started = ?, minutes_by = ?, minutes_at = ?, status = CASE WHEN status IN ('scheduled', 'rescheduled', 'postponed') THEN 'held' ELSE status END, updated_at = ? WHERE id = ?").bind(
        next, time_started, who, now, now, s.id,
      ),
      logStmt(env, user, submit ? 'minutes_submit' : 'minutes_save', 'committee_session', s.id, code, { minutes_status: [status, next] }),
    ]);
    return json({ ok: true, minutes_status: next });
  }

  if (method === 'POST' && (seg[3] === 'approve' || seg[3] === 'return') && seg.length === 4) {
    if (!canApprove) fail(403, 'forbidden');
    if (status !== 'pending') fail(409, 'mtg_minutes_not_pending');
    const approve = seg[3] === 'approve';
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE committee_sessions SET minutes_status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?').bind(
        approve ? 'approved' : 'draft', approve ? user.name_en || user.name : null, approve ? now : null, now, s.id,
      ),
      logStmt(env, user, approve ? 'minutes_approve' : 'minutes_return', 'committee_session', s.id, code, { minutes_status: [status, approve ? 'approved' : 'draft'] }),
    ]);
    // Members absent without excuse too many times in a row get an incident report sent to human resources.
    if (approve) {
      const job = absenceReports(env, c, s, code).catch((e) => console.error('absence reports', e));
      if (ctx.exec && ctx.exec.waitUntil) ctx.exec.waitUntil(job);
      else await job;
    }
    return json({ ok: true });
  }

  if (method === 'POST' && seg[3] === 'reopen' && seg.length === 4) {
    if (!manager) fail(403, 'forbidden');
    if (status !== 'approved') fail(409, 'mtg_minutes_not_pending');
    await env.DB.batch([
      env.DB.prepare("UPDATE committee_sessions SET minutes_status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), s.id),
      logStmt(env, user, 'minutes_reopen', 'committee_session', s.id, code, { minutes_status: ['approved', 'draft'] }),
    ]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

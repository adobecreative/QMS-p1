// The portal's home page: a few numbers from each system this person can open, the latest requests
// they follow, and the AI assistant card. One request, a handful of small queries (free plan: 50 per run).
import { isAdmin } from '../lib/config.js';
import { getSettings } from '../lib/db.js';
import { json, nowIso, todayIn } from '../lib/util.js';
import { statusOf, plusDays } from './docs.js';
import { portalDocsOn } from './fmslink.js';
import { meetingsHome } from './meetings.js';
import { qualityHome } from './quality.js';
import { aiReady, ticketScope } from './tickets.js';

const has = (r) => !!r && r !== 'none';
// Who sees the AI assistant's daily use: the people who run a system, never the staff using it.
const isManager = (u) => isAdmin(u) || u.desk === 'supervisor' || u.assets === 'manager' || u.rounds === 'manager' || u.quality === 'manager' || u.docs === 'dept_admin';

export async function handleHome(env, user) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const now = nowIso();
  const out = { today };
  const jobs = [];

  const scope = ticketScope(user);
  if (scope) {
    const late = `((t.status = 'new' AND t.response_due < ?${scope.binds.length + 1}) OR (t.status = 'in_progress' AND COALESCE(t.expected_at, t.resolve_due) < ?${scope.binds.length + 1}))`;
    jobs.push(
      env.DB.prepare(
        `SELECT SUM(t.status = 'new') AS new, SUM(t.status = 'in_progress') AS doing, SUM(t.status = 'on_hold') AS hold, SUM(${late}) AS late
           FROM tickets t WHERE ${scope.where} AND t.status <> 'closed'`,
      )
        .bind(...scope.binds, now)
        .first()
        .then((r) => (out.desk = { new: r.new || 0, doing: r.doing || 0, hold: r.hold || 0, late: r.late || 0 })),
      env.DB.prepare(
        `SELECT t.id, t.status, t.created_at, t.closed_at, ${late} AS late, c.name_ar AS cat_ar, c.name_en AS cat_en,
                d.name_ar AS dept_ar, d.name_en AS dept_en, COALESCE(l.name_ar, t.location_text) AS loc_ar, COALESCE(l.name_en, t.location_text) AS loc_en
           FROM tickets t JOIN ticket_categories c ON c.id = t.category_id
           LEFT JOIN departments d ON d.id = t.requester_dept_id LEFT JOIN locations l ON l.id = t.location_id
          WHERE ${scope.where} ORDER BY t.id DESC LIMIT 4`,
      )
        .bind(...scope.binds, now)
        .all()
        .then(({ results }) => (out.recent = results.map((r) => ({ ...r, late: !!r.late })))),
    );
  }

  if (has(user.quality)) jobs.push(qualityHome(env).then((r) => (out.quality = r)));
  jobs.push(meetingsHome(env, user, today).then((r) => r && (out.meetings = r)));

  if (has(user.assets)) {
    jobs.push(
      env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM assets WHERE status <> 'retired') AS total,
                (SELECT COUNT(*) FROM assets WHERE status = 'out_of_service') AS down,
                (SELECT COUNT(*) FROM pm_plans p JOIN assets a ON a.id = p.asset_id AND a.status <> 'retired' WHERE p.active = 1 AND p.next_due <= ?) AS pm_week`,
      )
        .bind(plusDays(today, 7))
        .first()
        .then((r) => (out.assets = r)),
    );
  }

  if (has(user.rounds)) {
    jobs.push(
      env.DB.prepare(
        `SELECT SUM(p.next_due <= ?1) AS due, SUM(p.next_due < ?1) AS late,
                (SELECT COUNT(*) FROM rounds WHERE done_on = ?1) AS done
           FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1 JOIN locations l ON l.id = p.location_id AND l.active = 1`,
      )
        .bind(today)
        .first()
        .then((r) => (out.rounds = { due: r.due || 0, late: r.late || 0, done: r.done || 0 })),
    );
  }

  // With the link reading the Operations system's register, documents live there: its numbers show here.
  if (has(user.docs) && portalDocsOn(settings)) {
    jobs.push(
      env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'near'), 0) AS near, COALESCE(SUM(status = 'expired'), 0) AS expired FROM portal_docs")
        .first()
        .then((r) => (out.docs = { total: r.total || 0, near: r.near, expired: r.expired })),
    );
  } else if (has(user.docs)) {
    const deptOnly = user.docs === 'dept_admin';
    const stmt = env.DB.prepare(`SELECT expiry_date, near_days, under_review FROM files ${deptOnly ? 'WHERE department_id = ?' : ''}`);
    jobs.push(
      (deptOnly ? stmt.bind(user.department_id ?? 0) : stmt).all().then(({ results }) => {
        const d = { total: results.length, near: 0, expired: 0 };
        for (const f of results) {
          const s = statusOf(f, today, settings.near_days).status;
          if (s === 'near') d.near++;
          if (s === 'expired') d.expired++;
        }
        out.docs = d;
      }),
    );
  }

  if (isAdmin(user)) {
    jobs.push(
      env.DB.prepare("SELECT (SELECT COUNT(*) FROM users WHERE active = 1 AND id <> (SELECT MIN(id) FROM users)) AS users, (SELECT COUNT(*) FROM departments) AS departments")
        .first()
        .then((r) => (out.admin = r)),
    );
  }

  // The assistant: everyone is told what it does; only managers see how much of today's allowance is used.
  const ready = aiReady(env, settings);
  out.ai = { ready };
  if (ready && isManager(user)) {
    jobs.push(
      env.DB.prepare('SELECT n FROM ai_usage WHERE day = ?')
        .bind(now.slice(0, 10))
        .first()
        .then((r) => (out.ai = { ready, used: r ? r.n : 0, limit: Number(settings.ai_daily_limit) })),
    );
  }

  await Promise.all(jobs);
  return json(out);
}

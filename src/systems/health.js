// The owner's health page: who uses the site, what failed, and the limits that matter on the free plan.
import { AUTO_BACKUP_PREFIX } from '../lib/backup.js';
import { getSettings, logStmt } from '../lib/db.js';
import { licenseOut } from '../lib/license.js';
import { fail, json, nowIso } from '../lib/util.js';

const DAYS = 14;
// Failures the site writes to the activity log: sending mail or alerts, backups, scheduled jobs, server errors.
const FAILURE_SQL = "((action LIKE '%\\_failed' ESCAPE '\\' AND action <> 'login_failed') OR action IN ('server_error', 'cron_failed'))";
const ERRORS_PER_HOUR = 50;

// An unexpected error on a request, kept for the health page (at most 50 an hour, so a loop cannot fill the log).
export async function logServerError(env, method, path, e) {
  try {
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM logs WHERE action = 'server_error' AND at > ?").bind(hourAgo).first();
    if (n.n >= ERRORS_PER_HOUR) return;
    await logStmt(env, null, 'server_error', 'api', null, `${method} ${path}`.slice(0, 200), { error: String((e && e.message) || e).slice(0, 300) }).run();
  } catch {
    /* the database itself may be what failed */
  }
}

export async function handleHealth(env, user, license) {
  const ownerId = (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
  if (user.id !== ownerId) fail(403, 'owner_only');
  const now = Date.now();
  const since = (days) => new Date(now - days * 86400000).toISOString();
  const from = since(DAYS - 1).slice(0, 10);
  const today = nowIso().slice(0, 10);
  const [users, seen, logins, activity, failedLogins, errors, errorCount, usage, aiDays, storage, push, settings, backups] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM users').first(),
    env.DB.prepare("SELECT COUNT(DISTINCT CASE WHEN at >= ?1 THEN user_id END) AS d7, COUNT(DISTINCT user_id) AS d30 FROM logs WHERE action = 'login' AND at >= ?2").bind(since(7), since(30)).first(),
    env.DB.prepare("SELECT substr(at, 1, 10) AS d, COUNT(*) AS n FROM logs WHERE action = 'login' AND at >= ? GROUP BY d").bind(from).all(),
    env.DB.prepare("SELECT substr(at, 1, 10) AS d, COUNT(*) AS n FROM logs WHERE action NOT IN ('login', 'login_failed', 'login_locked') AND at >= ? GROUP BY d").bind(from).all(),
    env.DB.prepare("SELECT COALESCE(SUM(action = 'login_failed'), 0) AS failed, COALESCE(SUM(action = 'login_locked'), 0) AS locked FROM logs WHERE action IN ('login_failed', 'login_locked') AND at >= ?").bind(since(7)).first(),
    env.DB.prepare(`SELECT id, at, action, entity, label, details FROM logs WHERE ${FAILURE_SQL} AND at >= ? ORDER BY id DESC LIMIT 30`).bind(since(30)).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM logs WHERE ${FAILURE_SQL} AND at >= ?`).bind(since(7)).first(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM tickets WHERE created_at >= ?1) AS tickets, (SELECT COUNT(*) FROM rounds WHERE done_at >= ?1) AS rounds,
              (SELECT COUNT(*) FROM stock_moves WHERE created_at >= ?1) AS moves, (SELECT COUNT(*) FROM files WHERE created_at >= ?1) AS files`,
    ).bind(since(30)).first(),
    env.DB.prepare('SELECT day AS d, n FROM ai_usage WHERE day >= ?').bind(from).all(),
    env.DB.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(pdf_size), 0) AS bytes FROM files').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first(),
    getSettings(env),
    env.FILES.list({ prefix: AUTO_BACKUP_PREFIX }),
  ]);
  const newest = backups.objects.sort((a, b) => (a.key < b.key ? 1 : -1))[0];
  const ai = aiDays.results.find((x) => x.d === today);
  return json({
    from,
    today,
    users: { total: users.total, active: users.active, seen_7: seen.d7, seen_30: seen.d30 },
    logins: logins.results,
    activity: activity.results,
    failed_logins: failedLogins.failed,
    locked: failedLogins.locked,
    errors: errors.results,
    errors_7: errorCount.n,
    usage_30: usage,
    ai: { enabled: settings.ai_enabled === '1', limit: settings.ai_daily_limit, today: ai ? ai.n : 0, days: aiDays.results },
    storage,
    push_devices: push.n,
    backup: newest ? { name: newest.key.slice(AUTO_BACKUP_PREFIX.length), at: newest.uploaded } : null,
    license: licenseOut(license),
  });
}

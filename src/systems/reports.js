// The monthly report and the compliance report.
import { checkEmail, readJson, requireRole } from '../lib/auth.js';
import { ADMIN_ROLES, appName } from '../lib/config.js';
import { getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { escHtml, fail, json, nowIso, str, todayIn } from '../lib/util.js';
import { PM_KINDS, endOfDay } from './assets.js';
import { CONTRACT_SELECT, contractOut } from './contracts.js';
import { plusDays } from './docs.js';
import { qualityMail, qualityReport } from './qreport.js';

// Monthly report (super admins): service desk, planned maintenance, rounds and documents for one month,
// with the month before for comparison and the last six months of requests. Months follow the site's time zone.
export const monthStart = (month, tz) => new Date(Date.parse(endOfDay(plusDays(month + '-01', -1), tz)) + 60000).toISOString();
export const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
export const prevMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export async function monthFigures(env, month, tz) {
  const from = monthStart(month, tz);
  const to = monthStart(nextMonth(month), tz);
  const fromDay = month + '-01';
  const toDay = plusDays(nextMonth(month) + '-01', -1);
  const [opened, closed, pm, rounds] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(received_at IS NOT NULL), 0) AS received, COALESCE(SUM(received_at IS NOT NULL AND received_at <= response_due), 0) AS resp_ok,
              AVG(CASE WHEN received_at IS NOT NULL THEN (julianday(received_at) - julianday(created_at)) * 1440 END) AS avg_resp_min,
              COALESCE(SUM(patient_impact), 0) AS impact
         FROM tickets WHERE pm_plan_id IS NULL AND created_at >= ?1 AND created_at < ?2`,
    ).bind(from, to).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(closed_at <= resolve_due), 0) AS res_ok, COALESCE(SUM(resolution = 'resolved'), 0) AS resolved,
              AVG((julianday(closed_at) - julianday(created_at)) * 24) AS avg_res_h, AVG(rating) AS rating, COUNT(rating) AS rated
         FROM tickets WHERE pm_plan_id IS NULL AND status = 'closed' AND closed_at >= ?1 AND closed_at < ?2`,
    ).bind(from, to).first(),
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(on_time), 0) AS ok FROM pm_done WHERE done_on >= ?1 AND done_on <= ?2').bind(fromDay, toDay).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(on_time), 0) AS ok, COALESCE(SUM(fail_n > 0), 0) AS with_fail, COALESCE(SUM(fail_n), 0) AS findings,
              COALESCE(SUM(scanned), 0) AS scanned FROM rounds WHERE done_on >= ?1 AND done_on <= ?2`,
    ).bind(fromDay, toDay).first(),
  ]);
  return { month, from, to, opened, closed, pm, rounds };
}

export async function handleReports(env, url, user, settings) {
  requireRole(user, ...ADMIN_ROLES);
  const thisMonth = todayIn(settings.timezone).slice(0, 7);
  const asked = str(url.searchParams.get('month'), 7);
  return json(await monthReport(env, settings, /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked <= thisMonth ? asked : thisMonth));
}

// Everything on the monthly report page, for one month: also what the monthly email is built from.
export async function monthReport(env, settings, month) {
  const tz = settings.timezone;
  const today = todayIn(tz);
  const thisMonth = today.slice(0, 7);
  const cur = await monthFigures(env, month, tz);
  const prev = await monthFigures(env, prevMonth(month), tz);
  const now = nowIso();
  let first = month;
  for (let i = 0; i < 5; i++) first = prevMonth(first);
  const trendFrom = monthStart(first, tz);
  const [teams, cats, places, depts, trend, openNow, pmLate, roundsLate, files, assets] = await Promise.all([
    env.DB.prepare(
      `SELECT t.team_id, d.name_ar, d.name_en,
              COALESCE(SUM(t.created_at >= ?1 AND t.created_at < ?2), 0) AS opened,
              COALESCE(SUM(t.status = 'closed' AND t.closed_at >= ?1 AND t.closed_at < ?2), 0) AS closed,
              COALESCE(SUM(t.status = 'closed' AND t.closed_at >= ?1 AND t.closed_at < ?2 AND t.closed_at <= t.resolve_due), 0) AS res_ok,
              COALESCE(SUM(t.status <> 'closed'), 0) AS open_now,
              AVG(CASE WHEN t.status = 'closed' AND t.closed_at >= ?1 AND t.closed_at < ?2 THEN t.rating END) AS rating
         FROM tickets t JOIN departments d ON d.id = t.team_id
        WHERE t.pm_plan_id IS NULL AND ((t.created_at >= ?1 AND t.created_at < ?2) OR (t.closed_at >= ?1 AND t.closed_at < ?2) OR t.status <> 'closed')
        GROUP BY t.team_id ORDER BY opened DESC`,
    ).bind(cur.from, cur.to).all(),
    env.DB.prepare(
      `SELECT c.name_ar, c.name_en, COUNT(*) AS n FROM tickets t JOIN ticket_categories c ON c.id = t.category_id
        WHERE t.pm_plan_id IS NULL AND t.created_at >= ?1 AND t.created_at < ?2 GROUP BY t.category_id ORDER BY n DESC LIMIT 10`,
    ).bind(cur.from, cur.to).all(),
    env.DB.prepare(
      `SELECT l.name_ar, l.name_en, COUNT(*) AS n FROM tickets t JOIN locations l ON l.id = t.location_id
        WHERE t.pm_plan_id IS NULL AND t.created_at >= ?1 AND t.created_at < ?2 GROUP BY t.location_id ORDER BY n DESC LIMIT 10`,
    ).bind(cur.from, cur.to).all(),
    env.DB.prepare(
      `SELECT d.name_ar, d.name_en, COUNT(*) AS n FROM tickets t JOIN departments d ON d.id = t.requester_dept_id
        WHERE t.pm_plan_id IS NULL AND t.created_at >= ?1 AND t.created_at < ?2 GROUP BY t.requester_dept_id ORDER BY n DESC LIMIT 10`,
    ).bind(cur.from, cur.to).all(),
    // Six months of requests by the month they were opened (site time zone, to the hour).
    env.DB.prepare(
      `SELECT strftime('%Y-%m', created_at, ?3) AS m, COUNT(*) AS opened,
              COALESCE(SUM(status = 'closed' AND closed_at <= resolve_due), 0) AS res_ok, COALESCE(SUM(status = 'closed'), 0) AS closed
         FROM tickets WHERE pm_plan_id IS NULL AND created_at >= ?1 AND created_at < ?2 GROUP BY m ORDER BY m`,
    ).bind(trendFrom, cur.to, tzModifier(tz)).all(),
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(resolve_due < ?), 0) AS late FROM tickets WHERE status <> 'closed' AND pm_plan_id IS NULL").bind(now).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM pm_plans p JOIN assets a ON a.id = p.asset_id WHERE p.active = 1 AND a.status = 'in_service' AND p.next_due < ?").bind(today).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1 JOIN locations l ON l.id = p.location_id AND l.active = 1 WHERE p.next_due < ?').bind(today).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(under_review = 0 AND expiry_date < ?1), 0) AS expired,
              COALESCE(SUM(under_review = 0 AND expiry_date >= ?1 AND expiry_date <= date(?1, '+' || COALESCE(near_days, ?2) || ' days')), 0) AS near,
              COALESCE(SUM(under_review = 1), 0) AS review
         FROM files`,
    ).bind(today, settings.near_days).first(),
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'in_service'), 0) AS in_service, COALESCE(SUM(status = 'out_of_service'), 0) AS out_of_service FROM assets WHERE status <> 'retired'").first(),
  ]);
  return {
    month, this_month: thisMonth, today, cur, prev,
    teams: teams.results, categories: cats.results, places: places.results, departments: depts.results, trend: trend.results,
    now: { open: openNow.n, late: openNow.late, pm_late: pmLate.n, rounds_late: roundsLate.n },
    files, assets,
  };
}

/* ------------------------- the monthly report by email ------------------------- */

export const REPORT_TEXT = {
  ar: {
    dir: 'rtl',
    subject: (m, app) => `تقرير شهر ${m} - ${app}`,
    title: (m) => `تقرير شهر ${m}`,
    intro: (p) => `أرقام الشهر، ومقابل كل رقم ما كان عليه في ${p}.`,
    col: ['البند', 'هذا الشهر', 'الشهر السابق'],
    desk: 'البلاغات',
    opened: 'بلاغات جديدة', closed: 'بلاغات مغلقة', resp_ok: 'الاستلام في الوقت المحدد', res_ok: 'الإغلاق في الوقت المحدد',
    avg_resp: 'متوسط زمن الاستلام (دقيقة)', avg_res: 'متوسط زمن الإغلاق (ساعة)', rating: 'متوسط التقييم (من 5)', impact: (s) => `بلاغات تؤثر على ${s.who_all_ar}`,
    maint: 'الصيانة والجولات',
    pm_done: 'أوامر صيانة منفذة', pm_ontime: 'الصيانة في موعدها', rounds_done: 'جولات منفذة', rounds_ontime: 'الجولات في موعدها', findings: 'بنود مخالفة في الجولات',
    now: 'الوضع الآن',
    open_now: 'بلاغات مفتوحة', late_now: 'منها متأخرة', pm_late: 'خطط صيانة متأخرة', rounds_late: 'جولات متأخرة', files_expired: 'وثائق منتهية', files_near: 'وثائق قاربت على الانتهاء',
    teams: 'حسب الفريق',
    team_cols: ['الفريق', 'جديدة', 'مغلقة', 'في الوقت', 'مفتوحة الآن'],
    cats: 'الأعطال الأكثر تكرارًا',
    open: 'فتح التقرير كاملًا',
    pdf: 'للنسخة PDF: افتح التقرير واضغط "طباعة" ثم اختر "حفظ بصيغة PDF".',
    footer: (app) => `رسالة شهرية تلقائية من ${app}. يمكن إيقافها من صفحة التقارير.`,
  },
  en: {
    dir: 'ltr',
    subject: (m, app) => `Report for ${m} - ${app}`,
    title: (m) => `Report for ${m}`,
    intro: (p) => `The month's figures, each beside its value for ${p}.`,
    col: ['Item', 'This month', 'Last month'],
    desk: 'Requests',
    opened: 'New requests', closed: 'Closed requests', resp_ok: 'Received on time', res_ok: 'Closed on time',
    avg_resp: 'Average time to receive (minutes)', avg_res: 'Average time to close (hours)', rating: 'Average rating (of 5)', impact: (s) => `Requests affecting ${s.who_all_en}`,
    maint: 'Maintenance and rounds',
    pm_done: 'Work orders done', pm_ontime: 'Maintenance on time', rounds_done: 'Rounds done', rounds_ontime: 'Rounds on time', findings: 'Failed round items',
    now: 'Now',
    open_now: 'Open requests', late_now: 'of them late', pm_late: 'Maintenance plans overdue', rounds_late: 'Rounds overdue', files_expired: 'Expired documents', files_near: 'Documents near expiry',
    teams: 'By team',
    team_cols: ['Team', 'New', 'Closed', 'On time', 'Open now'],
    cats: 'Most frequent problems',
    open: 'Open the full report',
    pdf: 'For a PDF: open the report, press "Print" and choose "Save as PDF".',
    footer: (app) => `Monthly automatic message from ${app}. It can be turned off on the Reports page.`,
  },
};

const MONTH_NAMES = {
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
export const monthLabel = (m, lang) => `${MONTH_NAMES[lang][Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export function monthMail(settings, d) {
  return bothLangs(settings, (s) => {
    const lang = s.email_lang;
    const L = REPORT_TEXT[lang];
    const ar = lang === 'ar';
    const align = ar ? 'right' : 'left';
    const cell = `padding:7px 10px;border-bottom:1px solid #f1eadb;text-align:${align};font-size:14px`;
    const head = (cols) => `<tr>${cols.map((c) => `<th style="${cell};background:#f6f0e2">${escHtml(c)}</th>`).join('')}</tr>`;
    const num = (v, digits) => (v === null || v === undefined ? '-' : Number(v).toFixed(digits || 0));
    const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
    const row = (label, a, b) => `<tr><td style="${cell}">${escHtml(label)}</td><td style="${cell}" dir="ltr"><b>${escHtml(String(a))}</b></td>${b === undefined ? '' : `<td style="${cell};color:#6e6553" dir="ltr">${escHtml(String(b))}</td>`}</tr>`;
    const table = (title, cols, rows) => `<h3 style="font-size:15px;margin:22px 0 8px">${escHtml(title)}</h3><table style="border-collapse:collapse;width:100%">${cols ? head(cols) : ''}${rows.join('')}</table>`;
    const { cur: c, prev: p } = d;
    const name = (r) => (ar ? r.name_ar : r.name_en || r.name_ar);
    const link = `${s.site_url || ''}/#/reports/overview`;
    const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
      <h2 style="font-size:18px;margin:0 0 6px">${escHtml(L.title(monthLabel(d.month, lang)))}</h2>
      <p style="margin:0;color:#6e6553">${escHtml(L.intro(monthLabel(p.month, lang)))}</p>
      ${table(L.desk, L.col, [
        row(L.opened, c.opened.n, p.opened.n),
        row(L.closed, c.closed.n, p.closed.n),
        row(L.resp_ok, pct(c.opened.resp_ok, c.opened.received), pct(p.opened.resp_ok, p.opened.received)),
        row(L.res_ok, pct(c.closed.res_ok, c.closed.n), pct(p.closed.res_ok, p.closed.n)),
        row(L.avg_resp, num(c.opened.avg_resp_min), num(p.opened.avg_resp_min)),
        row(L.avg_res, num(c.closed.avg_res_h, 1), num(p.closed.avg_res_h, 1)),
        row(L.rating, c.closed.rated ? num(c.closed.rating, 1) : '-', p.closed.rated ? num(p.closed.rating, 1) : '-'),
        row(L.impact(s), c.opened.impact, p.opened.impact),
      ])}
      ${table(L.maint, L.col, [
        row(L.pm_done, c.pm.n, p.pm.n),
        row(L.pm_ontime, pct(c.pm.ok, c.pm.n), pct(p.pm.ok, p.pm.n)),
        row(L.rounds_done, c.rounds.n, p.rounds.n),
        row(L.rounds_ontime, pct(c.rounds.ok, c.rounds.n), pct(p.rounds.ok, p.rounds.n)),
        row(L.findings, c.rounds.findings, p.rounds.findings),
      ])}
      ${table(L.now, null, [
        row(L.open_now, d.now.open),
        row(L.late_now, d.now.late),
        row(L.pm_late, d.now.pm_late),
        row(L.rounds_late, d.now.rounds_late),
        row(L.files_expired, d.files.expired),
        row(L.files_near, d.files.near),
      ])}
      ${d.teams.length ? table(L.teams, L.team_cols, d.teams.slice(0, 15).map((t) => `<tr><td style="${cell}">${escHtml(name(t))}</td><td style="${cell}" dir="ltr">${t.opened}</td><td style="${cell}" dir="ltr">${t.closed}</td><td style="${cell}" dir="ltr">${pct(t.res_ok, t.closed)}</td><td style="${cell}" dir="ltr">${t.open_now}</td></tr>`)) : ''}
      ${d.categories.length ? table(L.cats, null, d.categories.slice(0, 5).map((r) => row(name(r), r.n))) : ''}
      <p style="margin:22px 0 6px"><a href="${escHtml(link)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
      <p style="margin:0;font-size:12.5px;color:#6e6553">${escHtml(L.pdf)}</p>
      <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(appName(s, lang)))}</p></div>`;
    return { subject: L.subject(monthLabel(d.month, lang), appName(s, lang)), html };
  });
}

// Who gets it: the addresses saved on the Reports page, or else every active admin.
export async function reportRecipients(env, settings) {
  const saved = String(settings.report_to || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (saved.length) return saved;
  const { results } = await env.DB.prepare("SELECT email FROM users WHERE active = 1 AND role IN ('super_admin', 'systems_admin') ORDER BY id").all();
  return results.map((r) => r.email);
}

// Daily: on the first of the month, last month's report goes out once. force (the "send now" button) skips both checks.
export async function runMonthlyReport(env, actor, force) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const month = prevMonth(today.slice(0, 7));
  if (!force && (settings.monthly_report !== '1' || today.slice(8, 10) !== '01' || settings.monthly_report_sent === month)) return { sent: 0 };
  if (!mailReady(settings)) return { sent: 0, error: 'mail_not_configured' };
  const to = await reportRecipients(env, settings);
  if (!to.length) return { sent: 0, error: 'no_recipients' };
  // The quality report (the facilities one, monthReport, stays for the Operations system's code).
  const mail = qualityMail(settings, await qualityReport(env, settings, month));
  const result = await sendMail(settings, to.map((email) => ({ to: email, ...mail })));
  await env.DB.batch([
    ...(result.ok && !force ? [setSettingStmt(env, 'monthly_report_sent', month)] : []),
    logStmt(env, actor, result.ok ? 'send' : 'send_failed', 'month_report', null, month, result.ok ? { emails: to.length } : { error: result.error }),
  ]);
  return result.ok ? { sent: to.length, month, to } : { sent: 0, error: result.error };
}

export const REPORT_TO_MAX = 10;

// The Reports page: switch the monthly email on or off, choose who gets it, or send last month's now.
export async function handleReportMail(request, env, method, user) {
  if (!ADMIN_ROLES.includes(user.role) && user.quality_role !== 'manager') requireRole(user, ...ADMIN_ROLES);
  const settings = await getSettings(env);
  if (method === 'GET') return json({ on: settings.monthly_report === '1', to: settings.report_to, defaults: await reportRecipients(env, { report_to: '' }), mail_ready: mailReady(settings), last_sent: settings.monthly_report_sent || null });
  if (method === 'PUT') {
    const body = await readJson(request);
    const on = body.on ? '1' : '0';
    const list = [...new Set(String(body.to || '').split(/[,\s;]+/).filter(Boolean).map(checkEmail))];
    if (list.length > REPORT_TO_MAX) fail(400, 'too_many_recipients');
    const to = list.join(',');
    await env.DB.batch([
      setSettingStmt(env, 'monthly_report', on),
      setSettingStmt(env, 'report_to', to),
      logStmt(env, user, 'update', 'settings', null, null, { monthly_report: [settings.monthly_report, on], report_to: [settings.report_to || null, to || null] }),
    ]);
    return json({ ok: true, on: on === '1', to });
  }
  if (method === 'POST') {
    const r = await runMonthlyReport(env, user, true);
    if (r.error) fail(r.error === 'mail_not_configured' ? 409 : 400, r.error);
    return json(r);
  }
  fail(405, 'method_not_allowed');
}
/* --------------------------- Compliance report --------------------------- */

// What a JCI or CBAHI surveyor asks for, over a quarter or a year: planned maintenance and rounds done on time
// against what was due, how quickly faults were answered, contracts and documents still valid, and what is late now.
// A job counts in the period of the day it was due, so a late job stays against the period that missed it.
export const COMPLIANCE_TARGETS = { pm_high: 100, pm: 95, rounds: 95, response: 90, resolve: 90, docs: 100 };

export function compliancePeriod(asked, today) {
  const year = Number(today.slice(0, 4));
  const quarter = Math.ceil(Number(today.slice(5, 7)) / 3);
  let m = /^(\d{4})-Q([1-4])$/.exec(asked || '');
  let y = /^(\d{4})$/.exec(asked || '');
  let from;
  let to;
  let id;
  if (m && (Number(m[1]) < year || (Number(m[1]) === year && Number(m[2]) <= quarter)) && Number(m[1]) >= 2000) {
    const q = Number(m[2]);
    id = asked;
    from = `${m[1]}-${String(q * 3 - 2).padStart(2, '0')}`;
    to = `${m[1]}-${String(q * 3).padStart(2, '0')}`;
  } else if (y && Number(y[1]) <= year && Number(y[1]) >= 2000) {
    id = asked;
    from = `${y[1]}-01`;
    to = `${y[1]}-12`;
  } else {
    id = `${year}-Q${quarter}`;
    from = `${year}-${String(quarter * 3 - 2).padStart(2, '0')}`;
    to = `${year}-${String(quarter * 3).padStart(2, '0')}`;
  }
  return { id, this_quarter: `${year}-Q${quarter}`, from_month: from, to_month: to, from_day: from + '-01', to_day: plusDays(nextMonth(to) + '-01', -1) };
}

export async function handleCompliance(env, url, user, settings) {
  requireRole(user, ...ADMIN_ROLES);
  const tz = settings.timezone;
  const today = todayIn(tz);
  const p = compliancePeriod(str(url.searchParams.get('period'), 7), today);
  const fromIso = monthStart(p.from_month, tz);
  const toIso = monthStart(nextMonth(p.to_month), tz);
  // Jobs due today can still be done today: only the days before it count as missed.
  const until = p.to_day < today ? p.to_day : plusDays(today, -1);
  const all = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);
  const [pmDone, pmMissed, pmLate, assets, roundForms, roundsMissed, findings, tickets, contracts, uncovered, files, filesExpired] = await Promise.all([
    all(
      `SELECT d.kind, a.risk, COUNT(*) AS n, COALESCE(SUM(d.on_time), 0) AS ok FROM pm_done d JOIN assets a ON a.id = d.asset_id
        WHERE d.due >= ?1 AND d.due <= ?2 GROUP BY d.kind, a.risk`,
      p.from_day, p.to_day,
    ),
    all(
      `SELECT p.kind, a.risk, COUNT(*) AS n FROM pm_plans p JOIN assets a ON a.id = p.asset_id
        WHERE p.active = 1 AND a.status = 'in_service' AND p.next_due >= ?1 AND p.next_due <= ?2 GROUP BY p.kind, a.risk`,
      p.from_day, until,
    ),
    all(
      `SELECT a.tag, a.name_ar, a.name_en, a.risk, p.kind, p.next_due, l.name_ar AS loc_ar, l.name_en AS loc_en
         FROM pm_plans p JOIN assets a ON a.id = p.asset_id LEFT JOIN locations l ON l.id = a.location_id
        WHERE p.active = 1 AND a.status = 'in_service' AND p.next_due < ?1
        ORDER BY a.risk = 'high' DESC, p.next_due LIMIT 100`,
      today,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(a.risk = 'high'), 0) AS high, COALESCE(SUM(a.status = 'out_of_service'), 0) AS out_of_service,
              COALESCE(SUM(a.status = 'in_service' AND NOT EXISTS (SELECT 1 FROM pm_plans p WHERE p.asset_id = a.id AND p.active = 1)), 0) AS no_plan,
              COALESCE(SUM(a.status = 'in_service' AND a.risk = 'high' AND NOT EXISTS (SELECT 1 FROM pm_plans p WHERE p.asset_id = a.id AND p.active = 1)), 0) AS high_no_plan
         FROM assets a WHERE a.status <> 'retired'`,
    ).first(),
    all(
      `SELECT f.id, f.name_ar, f.name_en, COUNT(r.id) AS n, COALESCE(SUM(r.on_time), 0) AS ok, COALESCE(SUM(r.fail_n > 0), 0) AS with_fail,
              COALESCE(SUM(r.fail_n), 0) AS findings
         FROM round_forms f LEFT JOIN rounds r ON r.form_id = f.id AND r.due >= ?1 AND r.due <= ?2
        GROUP BY f.id HAVING f.active = 1 OR COUNT(r.id) > 0 ORDER BY f.name_ar`,
      p.from_day, p.to_day,
    ),
    all(
      `SELECT p.form_id, COUNT(*) AS n FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1 JOIN locations l ON l.id = p.location_id AND l.active = 1
        WHERE p.next_due >= ?1 AND p.next_due <= ?2 GROUP BY p.form_id`,
      p.from_day, until,
    ),
    // Each round with failed lines opens one request; it is closed once the team has fixed them.
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(t.status = 'closed'), 0) AS closed FROM rounds r JOIN tickets t ON t.id = r.ticket_id
        WHERE r.fail_n > 0 AND r.due >= ?1 AND r.due <= ?2`,
    )
      .bind(p.from_day, p.to_day)
      .first(),
    all(
      `SELECT priority, COUNT(*) AS n, COALESCE(SUM(received_at IS NOT NULL), 0) AS received,
              COALESCE(SUM(received_at IS NOT NULL AND received_at <= response_due), 0) AS resp_ok,
              COALESCE(SUM(status = 'closed'), 0) AS closed, COALESCE(SUM(status = 'closed' AND closed_at <= resolve_due), 0) AS res_ok,
              COALESCE(SUM(patient_impact), 0) AS impact
         FROM tickets WHERE pm_plan_id IS NULL AND created_at >= ?1 AND created_at < ?2 GROUP BY priority ORDER BY priority`,
      fromIso, toIso,
    ),
    // Contracts that ran in the period, or still run, and were not replaced by a renewal.
    all(CONTRACT_SELECT + ' WHERE c.end_date >= ?1 AND c.start_date <= ?2 ORDER BY c.end_date', p.from_day, today > p.to_day ? today : p.to_day).then((rows) =>
      rows.map((c) => contractOut(c, today)).filter((c) => c.state !== 'renewed'),
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM assets a WHERE a.risk = 'high' AND a.status = 'in_service'
          AND NOT EXISTS (SELECT 1 FROM contract_assets ca JOIN contracts c ON c.id = ca.contract_id WHERE ca.asset_id = a.id AND c.start_date <= ?1 AND c.end_date >= ?1)`,
    )
      .bind(today)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(under_review = 0 AND expiry_date < ?1), 0) AS expired,
              COALESCE(SUM(under_review = 0 AND expiry_date >= ?1 AND expiry_date <= date(?1, '+' || COALESCE(near_days, ?2) || ' days')), 0) AS near,
              COALESCE(SUM(under_review = 1), 0) AS review
         FROM files`,
    )
      .bind(today, settings.near_days)
      .first(),
    all(
      `SELECT f.name, f.file_number, f.expiry_date, d.name_ar AS dept_ar, d.name_en AS dept_en FROM files f JOIN departments d ON d.id = f.department_id
        WHERE f.under_review = 0 AND f.expiry_date < ?1 ORDER BY f.expiry_date LIMIT 100`,
      today,
    ),
  ]);

  // Planned maintenance by kind, with high-risk devices apart: they are held to 100%.
  const pmRow = () => ({ due: 0, done: 0, ok: 0 });
  const pm = { all: pmRow(), high: pmRow(), kinds: Object.fromEntries(PM_KINDS.map((k) => [k, pmRow()])) };
  const addPm = (r, field, n) => {
    for (const row of [pm.all, pm.kinds[r.kind], r.risk === 'high' ? pm.high : null]) if (row) row[field] += n;
  };
  for (const r of pmDone) {
    addPm(r, 'due', r.n);
    addPm(r, 'done', r.n);
    addPm(r, 'ok', r.ok);
  }
  for (const r of pmMissed) addPm(r, 'due', r.n);

  const missedBy = new Map(roundsMissed.map((r) => [r.form_id, r.n]));
  const rounds = roundForms.map((f) => ({ ...f, due: f.n + (missedBy.get(f.id) || 0), done: f.n }));
  const roundsAll = rounds.reduce((s, f) => ({ due: s.due + f.due, done: s.done + f.done, ok: s.ok + f.ok, findings: s.findings + f.findings }), { due: 0, done: 0, ok: 0, findings: 0 });

  const tk = tickets.reduce((s, r) => ({ n: s.n + r.n, received: s.received + r.received, resp_ok: s.resp_ok + r.resp_ok, closed: s.closed + r.closed, res_ok: s.res_ok + r.res_ok, impact: s.impact + r.impact }), {
    n: 0, received: 0, resp_ok: 0, closed: 0, res_ok: 0, impact: 0,
  });

  return json({
    period: p, today, targets: COMPLIANCE_TARGETS,
    pm, pm_late: pmLate, assets,
    rounds, rounds_all: roundsAll, findings,
    tickets, tickets_all: tk,
    contracts, uncovered_high: uncovered.n,
    files, files_expired: filesExpired,
  });
}

// SQLite shifts a UTC time to the site's time zone with "+N minutes"; the offset is taken for today.
export function tzModifier(tz) {
  const end = Date.parse(endOfDay(todayIn(tz), tz));
  const local = Date.parse(todayIn(tz) + 'T23:59:00Z');
  return `${Math.round((local - end) / 60000)} minutes`;
}

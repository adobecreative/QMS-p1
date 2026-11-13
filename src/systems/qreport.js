// The quality report: one month (or a whole year) of incidents, complaints and satisfaction, indicators against
// their targets, corrective actions, risks, improvement projects, the plan's goals and the accreditation readiness.
// The page shows it (and prints); on the 1st, last month's goes by email (see runMonthlyReport in reports.js).
import { appName } from '../lib/config.js';
import { getSettings } from '../lib/db.js';
import { bothLangs, emailHeader } from '../lib/mail.js';
import { escHtml, fail, json, todayIn } from '../lib/util.js';
import { kpiMet, kpiValue } from './kpis.js';
import { ovrReport } from './ovr.js';
import { yearGoals } from './qplan.js';
import { FRAMEWORKS, fwOn } from './quality.js';
import { riskRole } from './risk.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;
const prevMonth = (m) => (m.slice(5) === '01' ? `${Number(m.slice(0, 4)) - 1}-12` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) - 1).padStart(2, '0')}`);
const quarterOf = (m) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// The headline figures of a range of months (from..to, both 'YYYY-MM').
async function headline(env, from, to, today) {
  const r = (sql) => env.DB.prepare(sql).bind(from, to);
  const [ovr, pex, svy, capa] = await env.DB.batch([
    r(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(harm_final, harm) IN ('major', 'sentinel')), 0) AS severe, COALESCE(SUM(COALESCE(harm_final, harm) = 'near_miss'), 0) AS near_miss
         FROM ovr WHERE substr(occurred_at, 1, 7) >= ?1 AND substr(occurred_at, 1, 7) <= ?2`),
    r(`SELECT COALESCE(SUM(kind = 'complaint'), 0) AS complaints, COALESCE(SUM(kind = 'suggestion'), 0) AS suggestions, COALESCE(SUM(kind = 'praise'), 0) AS praise,
              COALESCE(SUM(kind = 'complaint' AND status = 'closed'), 0) AS closed, COALESCE(SUM(kind = 'complaint' AND status = 'closed' AND substr(closed_at, 1, 10) <= close_due), 0) AS on_time
         FROM pex WHERE substr(created_at, 1, 7) >= ?1 AND substr(created_at, 1, 7) <= ?2`),
    r('SELECT COUNT(*) AS responses, COALESCE(SUM(n), 0) AS answers, COALESCE(SUM(satisfied), 0) AS satisfied FROM survey_responses WHERE substr(day, 1, 7) >= ?1 AND substr(day, 1, 7) <= ?2'),
    r(`SELECT COALESCE(SUM(substr(created_at, 1, 7) >= ?1 AND substr(created_at, 1, 7) <= ?2), 0) AS opened,
              COALESCE(SUM(done_at IS NOT NULL AND substr(done_at, 1, 7) >= ?1 AND substr(done_at, 1, 7) <= ?2), 0) AS closed FROM capa`),
  ]);
  const s = svy.results[0];
  return {
    ovr: ovr.results[0],
    pex: pex.results[0],
    survey: { responses: s.responses, satisfied_pct: pct(s.satisfied, s.answers) },
    capa: capa.results[0],
    today,
  };
}

// The whole report for a month ('2026-10') or a year ('2026').
export async function qualityReport(env, settings, period) {
  const tz = settings.timezone;
  const today = todayIn(tz);
  const thisMonth = today.slice(0, 7);
  const year = period.slice(0, 4);
  const isYear = YEAR_RE.test(period);
  const from = isYear ? year + '-01' : period;
  let to = isYear ? year + '-12' : period;
  if (to > thisMonth) to = thisMonth;
  const prevFrom = isYear ? `${Number(year) - 1}-01` : prevMonth(period);
  const prevTo = isYear ? `${Number(year) - 1}-12` : prevMonth(period);
  const quarters = new Set();
  for (let m = from; m <= to; m = m.slice(5) === '12' ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) + 1).padStart(2, '0')}`) quarters.add(quarterOf(m));

  const [cur, prev, ovr, kpiRows, kpiVals, nowFigures, snaps, goals] = await Promise.all([
    headline(env, from, to, today),
    headline(env, prevFrom, prevTo, today),
    ovrReport(env, new URL(`http://x/?from=${from}&to=${to}`), today),
    env.DB.prepare('SELECT id, code, name_ar, name_en, unit, direction, target, frequency FROM kpis WHERE active = 1 ORDER BY code').all(),
    env.DB.prepare('SELECT kpi_id, period, num, den FROM kpi_values ORDER BY period DESC').all(),
    env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS open, COALESCE(SUM(due IS NOT NULL AND due < ?), 0) AS late FROM capa WHERE status IN ('open', 'doing')").bind(today),
      env.DB.prepare(
        `SELECT COUNT(*) AS open, COALESCE(SUM(likelihood * impact >= 15), 0) AS critical, COALESCE(SUM(likelihood * impact >= 10 AND likelihood * impact < 15), 0) AS high,
                COALESCE(SUM(next_review < ?1), 0) AS late, COALESCE(SUM(substr(created_at, 1, 7) >= ?2 AND substr(created_at, 1, 7) <= ?3), 0) AS new FROM risks WHERE status = 'open'`,
      ).bind(today, from, to),
      env.DB.prepare(
        `SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(substr(start_on, 1, 7) >= ?1 AND substr(start_on, 1, 7) <= ?2), 0) AS started,
                COALESCE(SUM(status = 'done' AND substr(closed_at, 1, 7) >= ?1 AND substr(closed_at, 1, 7) <= ?2), 0) AS done FROM pdsa`,
      ).bind(from, to),
      env.DB.prepare("SELECT COUNT(*) AS n FROM pdsa_cycles c JOIN pdsa p ON p.id = c.pdsa_id WHERE p.status = 'active' AND c.done_at IS NULL AND c.due < ?").bind(today),
      env.DB.prepare("SELECT p.code, p.title, p.status, (SELECT COUNT(*) FROM pdsa_cycles c WHERE c.pdsa_id = p.id) AS cycles FROM pdsa p WHERE p.status = 'active' OR (p.status = 'done' AND substr(p.closed_at, 1, 7) >= ?1 AND substr(p.closed_at, 1, 7) <= ?2) ORDER BY p.id DESC LIMIT 15").bind(from, to),
    ]),
    env.DB.prepare('SELECT month, framework, data FROM std_snapshots WHERE month <= ? ORDER BY month DESC').bind(to).all(),
    yearGoals(env, Number(year), today),
  ]);

  // Indicators: the latest value inside the period.
  const vals = {};
  for (const v of kpiVals.results) (vals[v.kpi_id] = vals[v.kpi_id] || []).push(v);
  const kpis = kpiRows.results.map((k) => {
    const inside = (vals[k.id] || []).find((v) => (k.frequency === 'quarterly' ? quarters.has(v.period) : v.period >= from && v.period <= to));
    const value = inside ? kpiValue(k, inside.num, inside.den) : null;
    return { code: k.code, name_ar: k.name_ar, name_en: k.name_en, unit: k.unit, direction: k.direction, target: k.target, period: inside ? inside.period : null, value, met: kpiMet(k, value) };
  });

  const ready = [];
  for (const fw of fwOn(settings)) {
    const s = snaps.results.find((x) => x.framework === fw);
    if (!s) continue;
    let d = {};
    try {
      d = JSON.parse(s.data);
    } catch {}
    ready.push({ framework: fw, name_ar: FRAMEWORKS[fw].name_ar, name_en: FRAMEWORKS[fw].name_en, pct: d.pct ?? null, esr_gap: d.esr_gap ?? null, month: s.month });
  }

  const [capaNow, riskNow, pdsaNow, cyclesLate, projects] = nowFigures.map((x) => x.results);
  const goalCount = (st) => goals.filter((g) => g.status === st).length;
  return {
    period, kind: isYear ? 'year' : 'month', from, to, prev_from: prevFrom, prev_to: prevTo, today,
    cur, prev,
    ovr: { totals: ovr.totals, categories: ovr.categories.slice(0, 5), departments: ovr.departments.slice(0, 5) },
    kpis: {
      total: kpis.length,
      met: kpis.filter((k) => k.met === true).length,
      below: kpis.filter((k) => k.met === false),
      missing: kpis.filter((k) => k.value === null).length,
    },
    capa: { ...cur.capa, open: capaNow[0].open, late: capaNow[0].late },
    risks: riskNow[0],
    pdsa: { ...pdsaNow[0], cycles_late: cyclesLate[0].n, list: projects },
    goals: { year: Number(year), n: goals.length, achieved: goalCount('achieved'), on_track: goalCount('on_track'), behind: goalCount('behind'), late: goalCount('late'), dropped: goalCount('dropped') },
    readiness: ready,
  };
}

// GET /qreport?period=2026-10 (or 2026): quality staff and the admins.
export async function handleQReport(env, url, user) {
  const role = riskRole(user);
  if (!role.viewer) fail(403, 'forbidden');
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const asked = url.searchParams.get('period') || '';
  const period = MONTH_RE.test(asked) || YEAR_RE.test(asked) ? asked : prevMonth(today.slice(0, 7));
  return json(await qualityReport(env, settings, period));
}

/* -------------------------------- the email -------------------------------- */

const MONTHS = {
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const label = (p, lang) => (YEAR_RE.test(p) ? p : `${MONTHS[lang][Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`);

const TEXT = {
  ar: {
    dir: 'rtl',
    subject: (m, app) => `تقرير الجودة - ${m} - ${app}`,
    title: (m) => `تقرير الجودة: ${m}`,
    col: ['البند', 'هذه الفترة', 'السابقة'],
    safety: 'سلامة المرضى',
    ovr: 'تقارير الحوادث OVR', severe: 'منها جسيمة أو جسيمة جداً', near_miss: 'كادت أن تحدث',
    pex: 'تجربة المريض',
    complaints: 'الشكاوى', closed_on_time: 'شكاوى أُغلقت في الوقت', praise: 'شكر', satisfaction: 'نسبة الرضا', responses: 'استبيانات',
    kpis: 'المؤشرات', kpi_met: 'تحقق المستهدف', kpi_below: 'تحت المستهدف', kpi_missing: 'بدون قيمة',
    below_cols: ['المؤشر', 'القيمة', 'المستهدف'],
    capa: 'الإجراءات التصحيحية CAPA', capa_opened: 'فُتحت', capa_closed: 'أُغلقت', capa_open: 'مفتوحة الآن', capa_late: 'متأخرة',
    risks: 'المخاطر', risk_open: 'مفتوحة', risk_critical: 'حرجة', risk_high: 'عالية', risk_late: 'مراجعة متأخرة',
    pdsa: 'مشاريع التحسين', pdsa_active: 'نشطة', pdsa_done: 'اكتملت', pdsa_late: 'دورات متأخرة',
    goals: (y) => `خطة الجودة ${y}`, g_achieved: 'تحققت', g_on_track: 'على المسار', g_behind: 'متأخرة عن المستهدف', g_late: 'فات موعدها',
    readiness: 'الجاهزية للاعتماد',
    open: 'فتح التقرير كاملًا',
    pdf: 'للنسخة PDF: افتح التقرير واضغط "طباعة" ثم اختر "حفظ بصيغة PDF".',
    footer: (app) => `رسالة شهرية تلقائية من ${app}.`,
  },
  en: {
    dir: 'ltr',
    subject: (m, app) => `Quality report - ${m} - ${app}`,
    title: (m) => `Quality report: ${m}`,
    col: ['Item', 'This period', 'Previous'],
    safety: 'Patient safety',
    ovr: 'Incident reports (OVR)', severe: 'of them major or sentinel', near_miss: 'Near misses',
    pex: 'Patient experience',
    complaints: 'Complaints', closed_on_time: 'Complaints closed on time', praise: 'Thanks', satisfaction: 'Satisfaction', responses: 'Surveys',
    kpis: 'Indicators', kpi_met: 'On target', kpi_below: 'Below target', kpi_missing: 'No value',
    below_cols: ['Indicator', 'Value', 'Target'],
    capa: 'Corrective actions (CAPA)', capa_opened: 'Opened', capa_closed: 'Closed', capa_open: 'Open now', capa_late: 'Late',
    risks: 'Risks', risk_open: 'Open', risk_critical: 'Critical', risk_high: 'High', risk_late: 'Review late',
    pdsa: 'Improvement projects', pdsa_active: 'Active', pdsa_done: 'Completed', pdsa_late: 'Cycles late',
    goals: (y) => `Quality plan ${y}`, g_achieved: 'Achieved', g_on_track: 'On track', g_behind: 'Behind target', g_late: 'Past due',
    readiness: 'Accreditation readiness',
    open: 'Open the full report',
    pdf: 'For a PDF: open the report, press "Print" and choose "Save as PDF".',
    footer: (app) => `Monthly automatic message from ${app}.`,
  },
};

const fmt = (k, v) => (v === null || v === undefined ? '-' : (Math.round(v * 100) / 100) + (k.unit === 'pct' ? '%' : ''));

export function qualityMail(settings, d) {
  return bothLangs(settings, (s) => {
    const lang = s.email_lang === 'en' ? 'en' : 'ar';
    const L = TEXT[lang];
    const align = lang === 'ar' ? 'right' : 'left';
    const cell = `padding:7px 10px;border-bottom:1px solid #f1eadb;text-align:${align};font-size:14px`;
    const head = (cols) => `<tr>${cols.map((c) => `<th style="${cell};background:#f6f0e2">${escHtml(c)}</th>`).join('')}</tr>`;
    const row = (lab, a, b) => `<tr><td style="${cell}">${escHtml(lab)}</td><td style="${cell}" dir="ltr"><b>${escHtml(String(a ?? '-'))}</b></td>${b === undefined ? '' : `<td style="${cell};color:#6e6553" dir="ltr">${escHtml(String(b ?? '-'))}</td>`}</tr>`;
    const table = (title, cols, rows) => `<h3 style="font-size:15px;margin:22px 0 8px">${escHtml(title)}</h3><table style="border-collapse:collapse;width:100%">${cols ? head(cols) : ''}${rows.join('')}</table>`;
    const name = (r) => (lang === 'ar' ? r.name_ar : r.name_en || r.name_ar);
    const c = d.cur;
    const p = d.prev;
    const sat = (x) => (x.survey.satisfied_pct === null ? '-' : x.survey.satisfied_pct + '%');
    const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
      <h2 style="font-size:18px;margin:0 0 6px">${escHtml(L.title(label(d.period, lang)))}</h2>
      ${table(L.safety, L.col, [row(L.ovr, c.ovr.n, p.ovr.n), row(L.severe, c.ovr.severe, p.ovr.severe), row(L.near_miss, c.ovr.near_miss, p.ovr.near_miss)])}
      ${table(L.pex, L.col, [row(L.complaints, c.pex.complaints, p.pex.complaints), row(L.closed_on_time, c.pex.on_time, p.pex.on_time), row(L.praise, c.pex.praise, p.pex.praise), row(L.satisfaction, sat(c), sat(p)), row(L.responses, c.survey.responses, p.survey.responses)])}
      ${table(L.kpis, null, [row(L.kpi_met, d.kpis.met), row(L.kpi_below, d.kpis.below.length), row(L.kpi_missing, d.kpis.missing)])}
      ${d.kpis.below.length ? table(L.kpi_below, L.below_cols, d.kpis.below.slice(0, 15).map((k) => `<tr><td style="${cell}">${escHtml(name(k))}</td><td style="${cell}" dir="ltr">${escHtml(fmt(k, k.value))}</td><td style="${cell}" dir="ltr">${escHtml(fmt(k, k.target))}</td></tr>`)) : ''}
      ${table(L.capa, null, [row(L.capa_opened, d.capa.opened), row(L.capa_closed, d.capa.closed), row(L.capa_open, d.capa.open), row(L.capa_late, d.capa.late)])}
      ${table(L.risks, null, [row(L.risk_open, d.risks.open), row(L.risk_critical, d.risks.critical), row(L.risk_high, d.risks.high), row(L.risk_late, d.risks.late)])}
      ${table(L.pdsa, null, [row(L.pdsa_active, d.pdsa.active), row(L.pdsa_done, d.pdsa.done), row(L.pdsa_late, d.pdsa.cycles_late)])}
      ${d.goals.n ? table(L.goals(d.goals.year), null, [row(L.g_achieved, d.goals.achieved + ' / ' + d.goals.n), row(L.g_on_track, d.goals.on_track), row(L.g_behind, d.goals.behind), row(L.g_late, d.goals.late)]) : ''}
      ${d.readiness.length ? table(L.readiness, null, d.readiness.map((r) => row(name(r), r.pct === null ? '-' : r.pct + '%'))) : ''}
      <p style="margin:22px 0 6px"><a href="${escHtml(`${s.site_url || ''}/#/reports/qreport/${d.period}`)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
      <p style="margin:0;font-size:12.5px;color:#6e6553">${escHtml(L.pdf)}</p>
      <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(appName(s, lang)))}</p></div>`;
    return { subject: L.subject(label(d.period, lang), appName(s, lang)), html };
  });
}

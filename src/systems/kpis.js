// Quality indicators (KPIs) and the accreditation readiness report.
// An indicator has a definition (numerator / denominator), a target, a direction and a period (month or quarter).
// Departments enter the numbers each period; a few indicators are worked out from the system's own data.
// Only totals are kept: never a patient's name or record.
import { readJson } from '../lib/auth.js';
import { isAdmin } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { ARABIC_RE, fail, json, nowIso, str, todayIn } from '../lib/util.js';
import { FRAMEWORKS, STD_SCORES, fwOn, readiness } from './quality.js';

export const KPI_UNITS = { pct: 100, per1000: 1000, value: 1 };
export const KPI_FREQ = ['monthly', 'quarterly'];
// Worked out from the system: rounds on time, corrective actions closed by their date, documents in date, meetings held.
export const KPI_AUTO = ['rounds', 'capa', 'docs', 'meetings', 'ovr_close', 'ovr_nm', 'pex_close', 'pex_sat'];
const KPI_CODE_RE = /^[A-Za-z0-9.\-_]{1,20}$/;

// Common hospital indicators to start from. Generic names only; each hospital sets its own targets.
export const KPI_LIBRARY = [
  { code: 'IPC-HH', name_ar: 'نسبة الالتزام بنظافة الأيدي', name_en: 'Hand hygiene compliance', chapter: 'IPC', unit: 'pct', direction: 'up', target: 90, num_ar: 'فرص النظافة المنفذة', den_ar: 'فرص النظافة المرصودة' },
  { code: 'IPC-CLABSI', name_ar: 'التهابات مجرى الدم المرتبطة بالقسطرة المركزية', name_en: 'CLABSI rate per 1000 line days', chapter: 'IPC', unit: 'per1000', direction: 'down', target: 1, num_ar: 'عدد الحالات', den_ar: 'أيام القسطرة المركزية' },
  { code: 'IPC-CAUTI', name_ar: 'التهابات المسالك المرتبطة بالقسطرة البولية', name_en: 'CAUTI rate per 1000 catheter days', chapter: 'IPC', unit: 'per1000', direction: 'down', target: 1, num_ar: 'عدد الحالات', den_ar: 'أيام القسطرة البولية' },
  { code: 'IPC-VAP', name_ar: 'الالتهاب الرئوي المرتبط بجهاز التنفس', name_en: 'VAP rate per 1000 ventilator days', chapter: 'IPC', unit: 'per1000', direction: 'down', target: 1, num_ar: 'عدد الحالات', den_ar: 'أيام جهاز التنفس' },
  { code: 'NR-FALL', name_ar: 'معدل سقوط المرضى', name_en: 'Patient falls per 1000 patient days', chapter: 'NR', unit: 'per1000', direction: 'down', target: 1, num_ar: 'حالات السقوط', den_ar: 'أيام التنويم' },
  { code: 'NR-PU', name_ar: 'معدل قرح الفراش المكتسبة', name_en: 'Hospital-acquired pressure injuries per 1000 patient days', chapter: 'NR', unit: 'per1000', direction: 'down', target: 1, num_ar: 'الحالات الجديدة', den_ar: 'أيام التنويم' },
  { code: 'MM-ERR', name_ar: 'معدل أخطاء الأدوية', name_en: 'Medication errors per 1000 orders', chapter: 'MM', unit: 'per1000', direction: 'down', target: 1, num_ar: 'الأخطاء المبلغ عنها', den_ar: 'الوصفات' },
  { code: 'QM-ID', name_ar: 'الالتزام بالتحقق من هوية المريض', name_en: 'Patient identification compliance', chapter: 'QM', unit: 'pct', direction: 'up', target: 95, num_ar: 'الحالات الملتزمة', den_ar: 'الحالات المرصودة' },
  { code: 'QM-SSC', name_ar: 'الالتزام بقائمة الجراحة الآمنة', name_en: 'Surgical safety checklist compliance', chapter: 'QM', unit: 'pct', direction: 'up', target: 95, num_ar: 'العمليات بقائمة مكتملة', den_ar: 'العمليات' },
  { code: 'QM-SAT', name_ar: 'رضا المرضى', name_en: 'Patient satisfaction', chapter: 'QM', unit: 'pct', direction: 'up', target: 85, num_ar: 'الإجابات الراضية', den_ar: 'كل الإجابات', auto: 'pex_sat' },
  { code: 'QM-CMP', name_ar: 'إغلاق الشكاوى في المدة المحددة', name_en: 'Complaints closed on time', chapter: 'QM', unit: 'pct', direction: 'up', target: 90, num_ar: 'الشكاوى المغلقة في المدة', den_ar: 'الشكاوى المستحقة', auto: 'pex_close' },
  { code: 'QM-READM', name_ar: 'إعادة الدخول خلال 30 يومًا', name_en: 'Readmissions within 30 days', chapter: 'QM', unit: 'pct', direction: 'down', target: 5, num_ar: 'حالات إعادة الدخول', den_ar: 'حالات الخروج' },
  { code: 'QM-ROUNDS', name_ar: 'جولات الجودة في موعدها', name_en: 'Quality rounds on time', chapter: 'QM', unit: 'pct', direction: 'up', target: 90, auto: 'rounds' },
  { code: 'QM-CAPA', name_ar: 'إغلاق الإجراءات التصحيحية في موعدها', name_en: 'Corrective actions closed on time', chapter: 'QM', unit: 'pct', direction: 'up', target: 85, auto: 'capa' },
  { code: 'QM-DOCS', name_ar: 'الوثائق السارية', name_en: 'Documents in date', chapter: 'QM', unit: 'pct', direction: 'up', target: 95, auto: 'docs' },
  { code: 'QM-OVR', name_ar: 'إغلاق بلاغات OVR في موعدها', name_en: 'OVR reports closed on time', chapter: 'QM', unit: 'pct', direction: 'up', target: 85, auto: 'ovr_close' },
  { code: 'QM-NM', name_ar: 'نسبة قريب من الخطأ في بلاغات OVR', name_en: 'Near misses among OVR reports', chapter: 'QM', unit: 'pct', direction: 'up', target: 30, auto: 'ovr_nm' },
  { code: 'LD-MTG', name_ar: 'اجتماعات اللجان المنعقدة في موعدها', name_en: 'Committee meetings held', chapter: 'LD', unit: 'pct', direction: 'up', target: 90, auto: 'meetings' },
];

// "2026-11" for a month, "2026-Q4" for a quarter, from a day.
export const periodOf = (day, freq) => (freq === 'quarterly' ? `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}` : day.slice(0, 7));
const PERIOD_RE = { monthly: /^\d{4}-(0[1-9]|1[0-2])$/, quarterly: /^\d{4}-Q[1-4]$/ };
// First and last day of a period.
export function periodRange(p) {
  const y = Number(p.slice(0, 4));
  const [m1, m2] = p[5] === 'Q' ? [(Number(p[6]) - 1) * 3 + 1, (Number(p[6]) - 1) * 3 + 3] : [Number(p.slice(5, 7)), Number(p.slice(5, 7))];
  const last = new Date(Date.UTC(y, m2, 0)).getUTCDate();
  const mm = (m) => String(m).padStart(2, '0');
  return [`${y}-${mm(m1)}-01`, `${y}-${mm(m2)}-${last}`];
}
// The period before (one month or one quarter back).
export function prevPeriod(p) {
  const y = Number(p.slice(0, 4));
  if (p[5] === 'Q') return Number(p[6]) === 1 ? `${y - 1}-Q4` : `${y}-Q${Number(p[6]) - 1}`;
  const m = Number(p.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export const kpiValue = (k, num, den) => (num === null || num === undefined ? null : k.unit === 'value' ? num : den > 0 ? Math.round((num / den) * KPI_UNITS[k.unit] * 100) / 100 : null);
export const kpiMet = (k, v) => (v === null || k.target === null || k.target === undefined ? null : k.direction === 'down' ? v <= k.target : v >= k.target);

// The numbers for an indicator the system works out, for one period (to today when the period is running).
async function autoFigures(env, auto, period, today) {
  const [from, end] = periodRange(period);
  const to = end < today ? end : today;
  if (from > today) return null;
  if (auto === 'rounds') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS den, COALESCE(SUM(on_time), 0) AS num FROM rounds WHERE done_on >= ? AND done_on <= ?').bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'capa') {
    // Actions due in the period (up to today): closed by their date.
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS den, COALESCE(SUM(done_at IS NOT NULL AND substr(done_at, 1, 10) <= due), 0) AS num FROM capa WHERE due >= ? AND due <= ?",
    ).bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'meetings') {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS den, COALESCE(SUM(status = 'held'), 0) AS num FROM committee_sessions WHERE date >= ? AND date <= ? AND status <> 'cancelled' AND date_tbd = 0",
    ).bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'ovr_close') {
    // Reports due in the period (up to today): closed by their date.
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS den, COALESCE(SUM(status = 'closed' AND substr(closed_at, 1, 10) <= due), 0) AS num FROM ovr WHERE due >= ? AND due <= ?",
    ).bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'pex_close') {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS den, COALESCE(SUM(status = 'closed' AND substr(closed_at, 1, 10) <= close_due), 0) AS num FROM pex WHERE kind = 'complaint' AND close_due >= ? AND close_due <= ?",
    ).bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'pex_sat') {
    const r = await env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS den, COALESCE(SUM(satisfied), 0) AS num FROM survey_responses WHERE day >= ? AND day <= ?').bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'ovr_nm') {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS den, COALESCE(SUM(COALESCE(harm_final, harm) = 'near_miss'), 0) AS num FROM ovr WHERE substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) <= ?",
    ).bind(from, to).first();
    return r.den ? r : null;
  }
  if (auto === 'docs') {
    // A count of today, so only the running period is filled; past periods keep what was saved then.
    if (end < today) return undefined;
    const s = await getSettings(env);
    const { portalDocsOn } = await import('./fmslink.js');
    if (portalDocsOn(s)) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS den, COALESCE(SUM(status IN ('valid', 'none')), 0) AS num FROM portal_docs").first();
      return r.den ? r : null;
    }
    const { statusOf } = await import('./docs.js');
    const { results } = await env.DB.prepare('SELECT expiry_date, near_days, under_review FROM files').all();
    if (!results.length) return null;
    const num = results.filter((f) => ['valid', 'none'].includes(statusOf(f, today, s.near_days).status)).length;
    return { num, den: results.length };
  }
  return null;
}

// Fill the running period and the one before for every automatic indicator (kept, so history builds up).
export async function refreshAutoKpis(env, today) {
  const { results: kpis } = await env.DB.prepare("SELECT * FROM kpis WHERE active = 1 AND source <> 'manual'").all();
  const now = nowIso();
  const stmts = [];
  for (const k of kpis) {
    const cur = periodOf(today, k.frequency);
    for (const p of [prevPeriod(cur), cur]) {
      const f = await autoFigures(env, k.source, p, today);
      if (f === undefined) continue;
      stmts.push(
        f
          ? env.DB.prepare(
              `INSERT INTO kpi_values (kpi_id, period, num, den, entered_by, entered_at) VALUES (?, ?, ?, ?, 'system', ?)
               ON CONFLICT (kpi_id, period) DO UPDATE SET num = excluded.num, den = excluded.den, entered_at = excluded.entered_at`,
            ).bind(k.id, p, f.num, f.den, now)
          : env.DB.prepare("DELETE FROM kpi_values WHERE kpi_id = ? AND period = ? AND entered_by = 'system'").bind(k.id, p),
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { kpis: kpis.length };
}

// The readiness of each framework this month, kept once a month for the trend.
export async function snapshotReadiness(env, today) {
  const settings = await getSettings(env);
  const month = today.slice(0, 7);
  const stmts = [];
  for (const fw of fwOn(settings)) {
    const [all, { results: by }] = await Promise.all([
      env.DB.prepare(STATS_SQL + ' WHERE active = 1 AND framework = ?').bind(fw).first(),
      env.DB.prepare(STATS_SQL.replace('SELECT', 'SELECT chapter,') + ' WHERE active = 1 AND framework = ? GROUP BY chapter').bind(fw).all(),
    ]);
    if (!all.n) continue;
    const data = { pct: readiness(all), esr_gap: all.esr_gap, n: all.n, chapters: Object.fromEntries(by.map((r) => [r.chapter, readiness(r)])) };
    stmts.push(env.DB.prepare('INSERT INTO std_snapshots (month, framework, data) VALUES (?, ?, ?) ON CONFLICT (month, framework) DO UPDATE SET data = excluded.data').bind(month, fw, JSON.stringify(data)));
  }
  if (stmts.length) await env.DB.batch(stmts);
}
const STATS_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(score = 'met'), 0) AS met, COALESCE(SUM(score = 'partial'), 0) AS partial,
  COALESCE(SUM(score = 'not_met'), 0) AS not_met, COALESCE(SUM(score = 'na'), 0) AS na, COALESCE(SUM(score IS NULL), 0) AS open,
  COALESCE(SUM(esr = 1 AND score IN ('partial', 'not_met')), 0) AS esr_gap FROM standards`;

export async function handleKpis(request, env, url, seg, method, user) {
  const role = user.quality || 'none';
  if (role === 'none' && !isAdmin(user)) fail(403, 'forbidden');
  const manager = isAdmin(user) || role === 'manager';
  // An assessor enters the numbers for the indicators of their department and those no department owns.
  const canEnter = (k) => manager || (role === 'assessor' && (!user.department_id || !k.department_id || k.department_id === user.department_id));
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const id = /^\d+$/.test(seg[1] || '') ? Number(seg[1]) : null;

  // Accreditation readiness: one framework's chapters, gaps and the monthly trend.
  if (seg[0] === 'readiness' && method === 'GET' && seg.length === 1) {
    await snapshotReadiness(env, today);
    const on = fwOn(settings);
    const fw = on.includes(url.searchParams.get('framework')) ? url.searchParams.get('framework') : on[0];
    const [all, { results: chapters }, { results: by }, { results: gaps }, { results: trend }, { results: depts }] = await Promise.all([
      env.DB.prepare(STATS_SQL + ' WHERE active = 1 AND framework = ?').bind(fw).first(),
      env.DB.prepare('SELECT code, name_ar, name_en FROM std_chapters WHERE framework = ? AND active = 1 ORDER BY sort, code').bind(fw).all(),
      env.DB.prepare(STATS_SQL.replace('SELECT', 'SELECT chapter,') + ' WHERE active = 1 AND framework = ? GROUP BY chapter').bind(fw).all(),
      env.DB.prepare(
        `SELECT s.id, s.code, s.chapter, s.title_ar, s.title_en, s.esr, s.score, d.name_ar AS dept_ar, d.name_en AS dept_en
           FROM standards s LEFT JOIN departments d ON d.id = s.department_id
          WHERE s.active = 1 AND s.framework = ? AND s.score IN ('not_met', 'partial')
          ORDER BY s.esr DESC, CASE s.score WHEN 'not_met' THEN 0 ELSE 1 END, s.chapter, s.code LIMIT 500`,
      ).bind(fw).all(),
      env.DB.prepare('SELECT month, data FROM std_snapshots WHERE framework = ? ORDER BY month DESC LIMIT 24').bind(fw).all(),
      env.DB.prepare(
        `SELECT d.name_ar, d.name_en, ${STATS_SQL.replace('SELECT ', '').replace(' FROM standards', '').replace(/\b(score|esr)\b(?= (=|IS|IN))/g, 's.$1')}
           FROM standards s JOIN departments d ON d.id = s.department_id WHERE s.active = 1 AND s.framework = ? GROUP BY s.department_id ORDER BY d.name_ar`,
      ).bind(fw).all(),
    ]);
    const map = Object.fromEntries(by.map((r) => [r.chapter, r]));
    return json({
      framework: fw,
      frameworks: on.map((key) => ({ key, ...FRAMEWORKS[key] })),
      has_esr: FRAMEWORKS[fw].esr,
      total: { ...all, pct: readiness(all) },
      chapters: chapters.map((c) => ({ ...c, ...(map[c.code] || { n: 0 }), pct: map[c.code] ? readiness(map[c.code]) : null })).filter((c) => c.n),
      departments: depts.map((d) => ({ ...d, pct: readiness(d) })),
      gaps,
      trend: trend.reverse().map((t) => ({ month: t.month, ...JSON.parse(t.data) })),
      today,
      scores: STD_SCORES,
    });
  }

  if (seg[0] !== 'kpis') return null;

  const readKpi = async (old) => {
    const body = await readJson(request);
    const n = {
      code: str(body.code, 20).replace(/\s+/g, '').toUpperCase(),
      name_ar: str(body.name_ar, 200),
      name_en: str(body.name_en, 200),
      chapter: str(body.chapter, 6).toUpperCase() || null,
      std_code: str(body.std_code, 30).replace(/\s+/g, '').toUpperCase() || null,
      department_id: Number(body.department_id) || null,
      num_ar: str(body.num_ar, 300) || null,
      den_ar: str(body.den_ar, 300) || null,
      unit: Object.keys(KPI_UNITS).includes(body.unit) ? body.unit : 'pct',
      direction: body.direction === 'down' ? 'down' : 'up',
      target: body.target === '' || body.target === null || body.target === undefined || !Number.isFinite(Number(body.target)) ? null : Number(body.target),
      frequency: KPI_FREQ.includes(body.frequency) ? body.frequency : 'monthly',
      source: KPI_AUTO.includes(body.source) ? body.source : 'manual',
      active: body.active === false ? 0 : 1,
    };
    if (!KPI_CODE_RE.test(n.code)) fail(400, 'kpi_bad_code');
    if (!n.name_ar || !n.name_en) fail(400, 'name_required');
    if (ARABIC_RE.test(n.name_en)) fail(400, 'field_arabic');
    if (n.chapter && !(await env.DB.prepare("SELECT 1 FROM std_chapters WHERE framework = 'cbahi' AND code = ?").bind(n.chapter).first())) fail(400, 'std_bad_chapter');
    const dup = await env.DB.prepare('SELECT id FROM kpis WHERE code = ?').bind(n.code).first();
    if (dup && (!old || dup.id !== old.id)) fail(409, 'kpi_code_taken');
    return n;
  };
  const insertKpi = (n, now) =>
    env.DB.prepare(
      `INSERT INTO kpis (code, name_ar, name_en, chapter, std_code, department_id, num_ar, den_ar, unit, direction, target, frequency, source, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(n.code, n.name_ar, n.name_en, n.chapter, n.std_code, n.department_id, n.num_ar, n.den_ar, n.unit, n.direction, n.target, n.frequency, n.source, n.active, now, now);

  // Every indicator with its last 12 values.
  if (method === 'GET' && seg.length === 1) {
    await refreshAutoKpis(env, today);
    const [{ results: kpis }, { results: values }, { results: chapters }, { results: departments }] = await Promise.all([
      env.DB.prepare('SELECT k.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM kpis k LEFT JOIN departments d ON d.id = k.department_id ORDER BY k.active DESC, k.chapter, k.code').all(),
      env.DB.prepare('SELECT kpi_id, period, num, den, note, entered_by, entered_at FROM kpi_values ORDER BY period').all(),
      env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' AND active = 1 ORDER BY sort, code").all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
    ]);
    const by = {};
    for (const v of values) (by[v.kpi_id] = by[v.kpi_id] || []).push(v);
    const used = new Set(kpis.map((k) => k.code));
    return json({
      kpis: kpis.map((k) => {
        const vals = (by[k.id] || []).slice(-12).map((v) => ({ ...v, value: kpiValue(k, v.num, v.den) }));
        return { ...k, values: vals.map((v) => ({ ...v, met: kpiMet(k, v.value) })), current: periodOf(today, k.frequency), can_enter: canEnter(k) && k.source === 'manual' };
      }),
      library: KPI_LIBRARY.filter((x) => !used.has(x.code)),
      chapters,
      departments,
      today,
      can_manage: manager,
    });
  }

  // Add one indicator, or several from the library (codes).
  if (method === 'POST' && seg.length === 1) {
    if (!manager) fail(403, 'forbidden');
    const n = await readKpi(null);
    const res = await insertKpi(n, nowIso()).run();
    await logStmt(env, user, 'create', 'kpi', res.meta.last_row_id, n.name_ar).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if (method === 'POST' && seg[1] === 'library' && seg.length === 2) {
    if (!manager) fail(403, 'forbidden');
    const body = await readJson(request);
    const want = new Set((Array.isArray(body.codes) ? body.codes : []).map((c) => String(c)));
    const { results: have } = await env.DB.prepare('SELECT code FROM kpis').all();
    const { results: chs } = await env.DB.prepare("SELECT code FROM std_chapters WHERE framework = 'cbahi'").all();
    const chSet = new Set(chs.map((c) => c.code));
    const haveSet = new Set(have.map((c) => c.code));
    const now = nowIso();
    const add = KPI_LIBRARY.filter((x) => want.has(x.code) && !haveSet.has(x.code)).map((x) => ({
      ...x, chapter: chSet.has(x.chapter) ? x.chapter : null, std_code: null, department_id: null, num_ar: x.num_ar || null, den_ar: x.den_ar || null, frequency: 'monthly', source: x.auto || 'manual', active: 1,
    }));
    if (!add.length) fail(400, 'kpi_none');
    await env.DB.batch([...add.map((n) => insertKpi(n, now)), logStmt(env, user, 'create', 'kpi', null, 'library', { codes: add.map((x) => x.code) })]);
    return json({ ok: true, added: add.length });
  }

  const k = id !== null ? await env.DB.prepare('SELECT * FROM kpis WHERE id = ?').bind(id).first() : null;
  if (!k) fail(404, 'not_found');

  if (method === 'PUT' && seg.length === 2) {
    if (!manager) fail(403, 'forbidden');
    const n = await readKpi(k);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE kpis SET code = ?, name_ar = ?, name_en = ?, chapter = ?, std_code = ?, department_id = ?, num_ar = ?, den_ar = ?, unit = ?, direction = ?, target = ?,
                frequency = ?, source = ?, active = ?, updated_at = ? WHERE id = ?`,
      ).bind(n.code, n.name_ar, n.name_en, n.chapter, n.std_code, n.department_id, n.num_ar, n.den_ar, n.unit, n.direction, n.target, n.frequency, n.source, n.active, nowIso(), id),
      // A change of period type leaves values of the other kind behind; they stop showing.
      logStmt(env, user, 'update', 'kpi', id, n.name_ar, changes(k, n, ['code', 'name_ar', 'target', 'direction', 'unit', 'frequency', 'source', 'active'])),
    ]);
    return json({ ok: true });
  }
  if (method === 'DELETE' && seg.length === 2) {
    if (!manager) fail(403, 'forbidden');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM kpi_values WHERE kpi_id = ?').bind(id),
      env.DB.prepare('DELETE FROM kpis WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'kpi', id, k.name_ar),
    ]);
    return json({ ok: true });
  }

  // A period's numbers: entered (or cleared) by the department or quality. Automatic indicators fill themselves.
  if (method === 'PUT' && seg[2] === 'values' && seg.length === 3) {
    if (k.source !== 'manual') fail(400, 'kpi_auto');
    if (!canEnter(k)) fail(403, 'forbidden');
    const body = await readJson(request);
    const period = str(body.period, 7);
    if (!PERIOD_RE[k.frequency].test(period) || period > periodOf(today, k.frequency)) fail(400, 'kpi_bad_period');
    const num = body.num === '' || body.num === null || body.num === undefined ? null : Number(body.num);
    const den = body.den === '' || body.den === null || body.den === undefined ? null : Number(body.den);
    if (num === null) {
      await env.DB.batch([env.DB.prepare('DELETE FROM kpi_values WHERE kpi_id = ? AND period = ?').bind(id, period), logStmt(env, user, 'delete', 'kpi_value', id, k.name_ar, { period })]);
      return json({ ok: true, value: null });
    }
    if (!Number.isFinite(num) || num < 0) fail(400, 'kpi_bad_number');
    if (k.unit !== 'value' && (!Number.isFinite(den) || den <= 0)) fail(400, 'kpi_bad_number');
    if (k.unit === 'pct' && num > den) fail(400, 'kpi_num_over');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO kpi_values (kpi_id, period, num, den, note, entered_by, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kpi_id, period) DO UPDATE SET num = excluded.num, den = excluded.den, note = excluded.note, entered_by = excluded.entered_by, entered_at = excluded.entered_at`,
      ).bind(id, period, num, k.unit === 'value' ? null : den, str(body.note, 500) || null, user.name, now),
      logStmt(env, user, 'update', 'kpi_value', id, k.name_ar, { period, num, den }),
    ]);
    const value = kpiValue(k, num, den);
    return json({ ok: true, value, met: kpiMet(k, value) });
  }
  fail(405, 'method_not_allowed');
}

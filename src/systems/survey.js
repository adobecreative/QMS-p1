// Mock surveys and tracers.
// Mock survey: the quality manager picks a framework and chapters, gives each chapter to an assessor, and the team
// scores them on the same scoring page as the self-assessment. The scores are kept with the survey (mock_scores) and
// leave the official assessment alone until the manager applies them. Closing opens a CAPA for each standard with a
// gap; the report shows readiness by chapter, the ESR gaps and the change since the last survey.
// Tracer: a patient's path through the units (one set of questions at each station) or one system across the
// hospital (medication, infection, facility, data). Each line is met, not met or n/a; closing opens a CAPA for each
// line not met.
import { readJson } from '../lib/auth.js';
import { logStmt } from '../lib/db.js';
import { getSettings } from '../lib/db.js';
import { fail, json, nowIso, optDate, str, todayIn } from '../lib/util.js';
import { CAPA_DAYS } from './capa.js';
import { plusDays } from './docs.js';
import { FRAMEWORKS, STD_ACTIVITIES, STD_SCORES, fwOn, readiness, rollup } from './quality.js';
import { riskRole } from './risk.js';

export const TRACER_KINDS = ['patient', 'system'];
export const TRACER_TOPICS = ['medication', 'infection', 'facility', 'data'];
export const TRACER_RESULTS = ['met', 'not_met', 'na'];
const MAX_ITEMS = 200;

// The questions a tracer starts from: for a patient, asked at every station on the path; for a system, the whole
// list once. [Arabic, English, chapter]. They are the hospital's own wording and can be added to on each tracer.
export const TRACER_TEMPLATES = {
  patient: [
    ['التحقق من هوية المريض بمعرّفين قبل الرعاية', 'Patient identified with two identifiers before care', 'NR'],
    ['التقييم الأولي موثق في الوقت المحدد', 'Initial assessment documented on time', 'NR'],
    ['خطة الرعاية موثقة ومحدثة', 'Care plan documented and up to date', 'NR'],
    ['الأدوية مطابقة للوصفة ومحفوظة بأمان', 'Medications match the orders and are stored safely', 'MM'],
    ['نظافة الأيدي ملتزم بها أثناء الملاحظة', 'Hand hygiene observed during care', 'IPC'],
    ['تقييم خطر السقوط والألم موثق', 'Fall risk and pain assessed and documented', 'NR'],
    ['الموافقة المستنيرة موقعة عند الحاجة', 'Informed consent signed where needed', null],
    ['تثقيف المريض وأسرته موثق', 'Patient and family education documented', null],
    ['التسليم بين الوحدات موثق', 'Handover between units documented', 'NR'],
    ['الطاقم يعرف طريقة الإبلاغ عن حادث', 'Staff know how to report an incident', 'QM'],
  ],
  medication: [
    ['سجل حرارة ثلاجة الأدوية مكتمل', 'Medication fridge temperature log complete', 'MM'],
    ['الأدوية عالية الخطورة معزولة وعليها ملصق', 'High-alert medications separated and labelled', 'MM'],
    ['الأدوية المتشابهة (LASA) مفصولة', 'Look-alike sound-alike medications separated', 'MM'],
    ['لا توجد أدوية منتهية الصلاحية', 'No expired medications', 'MM'],
    ['مطابقة الأدوية عند الدخول موثقة', 'Medication reconciliation on admission documented', 'MM'],
    ['عربة الطوارئ مفحوصة ومختومة', 'Crash cart checked and sealed', 'MM'],
    ['جرد الأدوية المخدرة مطابق', 'Narcotics count matches', 'MM'],
    ['الطاقم يعرف الإبلاغ عن الأعراض الجانبية', 'Staff know how to report adverse drug reactions', 'MM'],
  ],
  infection: [
    ['الالتزام بنظافة الأيدي يُراقب ويُبلّغ', 'Hand hygiene compliance monitored and reported', 'IPC'],
    ['معدات الوقاية الشخصية متوفرة', 'Personal protective equipment available', 'IPC'],
    ['لوحات العزل واضحة ومطبقة', 'Isolation signs in place and followed', 'IPC'],
    ['المستلزمات المعقمة محفوظة وصالحة', 'Sterile supplies stored properly and in date', 'IPC'],
    ['جداول التنظيف مكتملة', 'Cleaning schedules complete', 'IPC'],
    ['حاويات الأدوات الحادة دون ثلاثة أرباع', 'Sharps containers below three quarters full', 'IPC'],
    ['الطاقم يعرف إجراء التعرض للدم', 'Staff know the blood exposure procedure', 'IPC'],
    ['بيانات الترصد تُرفع للجنة', 'Surveillance data reported to the committee', 'IPC'],
  ],
  facility: [
    ['مخارج الطوارئ خالية', 'Fire exits clear', 'FMS'],
    ['طفايات الحريق مفحوصة', 'Fire extinguishers inspected', 'FMS'],
    ['الطاقم يعرف خطة الحريق', 'Staff know the fire plan', 'FMS'],
    ['ملصقات الصيانة الوقائية على الأجهزة سارية', 'Equipment preventive maintenance labels current', 'FMS'],
    ['نشرات سلامة المواد الخطرة متوفرة', 'Safety data sheets available for hazardous materials', 'FMS'],
    ['سجلات فحص المرافق مكتملة', 'Utility check logs complete', 'FMS'],
    ['ضبط الدخول للمناطق المقيدة', 'Restricted areas access controlled', 'FMS'],
    ['تمرين الطوارئ نُفذ في موعده', 'Emergency drill done on schedule', 'FMS'],
  ],
  data: [
    ['المؤشرات تُجمع حسب تعريفها', 'Indicators collected as defined', 'QM'],
    ['البيانات يتم التحقق منها', 'Data validated', 'QM'],
    ['النتائج تُعرض على اللجنة', 'Results reported to the committee', 'QM'],
    ['إجراء تحسين للمؤشرات دون المستهدف', 'Improvement action on indicators below target', 'QM'],
    ['تقارير الحوادث تُراجع وتُغلق', 'Incident reports reviewed and closed', 'QM'],
    ['سرية البيانات محفوظة', 'Data confidentiality kept', 'QM'],
  ],
};

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const chaptersOf = (s) => String(s || '').split(',').filter(Boolean);
const parseActs = (v) => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

async function addCapa(env, x) {
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO capa (source, title, detail, department_id, chapter, std_code, due, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, (SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?), ?, ?, 'open', ?, ?, ?)`,
  )
    .bind(x.source, x.title.slice(0, 500), x.detail || null, x.department_id || null, x.chapter || '', x.std_code || null, x.due, x.by || null, now, now)
    .run();
  return res.meta.last_row_id;
}

async function nextCode(env, table, prefix) {
  const r = await env.DB.prepare(`SELECT MAX(CAST(substr(code, ${prefix.length + 2}) AS INTEGER)) AS m FROM ${table} WHERE code LIKE '${prefix}-%'`).first();
  return prefix + '-' + String((r.m || 0) + 1).padStart(3, '0');
}

/* ------------------------------ survey scores ------------------------------ */

// The standards of the survey's chapters, each with its elements and the survey's scores on them. A standard's
// score comes from its elements (or its own row, element 0, when it has none).
async function surveyStandards(env, sv, chapter) {
  const chs = chapter ? [chapter] : chaptersOf(sv.chapters);
  if (!chs.length) return [];
  const q = chs.map(() => '?').join(',');
  const where = `s.active = 1 AND s.framework = ? AND s.chapter IN (${q})`;
  const [{ results: stds }, { results: els }, { results: scores }] = await Promise.all([
    env.DB.prepare(
      `SELECT s.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM standards s LEFT JOIN departments d ON d.id = s.department_id WHERE ${where} ORDER BY s.chapter, s.id LIMIT 3000`,
    ).bind(sv.framework, ...chs).all(),
    env.DB.prepare(`SELECT e.* FROM std_elements e JOIN standards s ON s.id = e.standard_id WHERE ${where} ORDER BY e.standard_id, e.sort, e.id LIMIT 20000`).bind(sv.framework, ...chs).all(),
    env.DB.prepare('SELECT * FROM mock_scores WHERE survey_id = ?').bind(sv.id).all(),
  ]);
  const sc = {};
  for (const r of scores) sc[r.standard_id + ':' + r.element_id] = r;
  const byStd = {};
  for (const e of els) (byStd[e.standard_id] = byStd[e.standard_id] || []).push(e);
  const esrOn = FRAMEWORKS[sv.framework]?.esr;
  return stds.map((s) => {
    const elements = (byStd[s.id] || []).map((e) => {
      const r = sc[s.id + ':' + e.id];
      const acts = r ? parseActs(r.acts).map((a, i) => ({ id: i + 1, ...a })) : [];
      return { ...e, score: r ? r.score : null, note: r ? r.note : null, activities: acts, official: e.score };
    });
    const own = sc[s.id + ':0'];
    const score = elements.length ? rollup(elements.map((e) => e.score), esrOn && s.esr) : own ? own.score : null;
    return { ...s, official: s.score, score, note: own ? own.note : null, elements, own_acts: own ? parseActs(own.acts).map((a, i) => ({ id: i + 1, ...a })) : [] };
  });
}

// Readiness of a list of standards with their survey scores, the same way as the self-assessment.
function tally(stds) {
  const r = { n: stds.length, met: 0, partial: 0, not_met: 0, na: 0, open: 0, esr: 0, esr_gap: 0 };
  for (const s of stds) {
    if (s.score) r[s.score]++;
    else r.open++;
    if (s.esr) {
      r.esr++;
      if (s.score === 'partial' || s.score === 'not_met') r.esr_gap++;
    }
  }
  return { ...r, pct: readiness(r) };
}

// One survey's results by chapter, its ESR gaps, and how far the scoring has gone.
export async function surveyResults(env, sv) {
  const stds = await surveyStandards(env, sv);
  const chapters = chaptersOf(sv.chapters).map((code) => ({ code, ...tally(stds.filter((s) => s.chapter === code)) }));
  const units = stds.flatMap((s) => (s.elements.length ? s.elements : [s]));
  return {
    total: tally(stds),
    chapters,
    esr_gaps: FRAMEWORKS[sv.framework]?.esr ? stds.filter((s) => s.esr && (s.score === 'partial' || s.score === 'not_met')).map((s) => ({ id: s.id, code: s.code, title_ar: s.title_ar, title_en: s.title_en, score: s.score, note: s.note })) : [],
    gaps: stds.filter((s) => s.score === 'partial' || s.score === 'not_met').length,
    scored: units.filter((u) => u.score).length,
    units: units.length,
    stds,
  };
}

/* --------------------------------- access --------------------------------- */

export function surveyRole(u) {
  const r = riskRole(u);
  return { manager: r.manager, officer: r.officer, viewer: r.viewer };
}

/* --------------------------------- surveys --------------------------------- */

export async function handleMock(request, env, url, seg, method, user) {
  const role = surveyRole(user);
  if (!role.viewer) fail(403, 'forbidden');
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const needManager = () => {
    if (!role.manager) fail(403, 'forbidden');
  };

  const readHead = async (old) => {
    const body = await readJson(request);
    const fw = old ? old.framework : str(body.framework, 10) || fwOn(settings)[0];
    if (!FRAMEWORKS[fw]) fail(400, 'std_bad_framework');
    const title = str(body.title, 200);
    if (!title) fail(400, 'name_required');
    const { results: all } = await env.DB.prepare('SELECT code FROM std_chapters WHERE framework = ? AND active = 1').bind(fw).all();
    const known = new Set(all.map((c) => c.code));
    const chapters = (Array.isArray(body.chapters) ? body.chapters : []).map((c) => String(c).toUpperCase()).filter((c, i, a) => known.has(c) && a.indexOf(c) === i);
    if (!chapters.length) fail(400, 'mock_no_chapters');
    const start_on = optDate(body.start_on) || today;
    const end_on = optDate(body.end_on);
    if (end_on && end_on < start_on) fail(400, 'pdsa_bad_dates');
    const assign = {};
    const given = body.assign && typeof body.assign === 'object' ? body.assign : {};
    for (const c of chapters) if (toId(given[c])) assign[c] = toId(given[c]);
    return { framework: fw, title, chapters: ',' + chapters.join(',') + ',', list: chapters, start_on, end_on, assign };
  };
  const assignStmts = (id, n) => [
    env.DB.prepare('DELETE FROM mock_assign WHERE survey_id = ?').bind(id),
    ...Object.entries(n.assign).map(([c, u]) => env.DB.prepare('INSERT INTO mock_assign (survey_id, chapter, user_id) SELECT ?, ?, id FROM users WHERE id = ? AND active = 1').bind(id, c, u)),
  ];

  // The surveys, the tracers, and what is needed to start one.
  if (method === 'GET' && seg.length === 1) {
    const [{ results: surveys }, { results: tracers }, { results: chapters }, { results: people }, { results: departments }] = await Promise.all([
      env.DB.prepare('SELECT * FROM mock_surveys ORDER BY id DESC LIMIT 200').all(),
      env.DB.prepare(
        `SELECT t.*, d.name_ar AS dept_ar, d.name_en AS dept_en, m.code AS survey_code,
                (SELECT COUNT(*) FROM tracer_items i WHERE i.tracer_id = t.id) AS n_items,
                (SELECT COUNT(*) FROM tracer_items i WHERE i.tracer_id = t.id AND i.result = 'met') AS n_met,
                (SELECT COUNT(*) FROM tracer_items i WHERE i.tracer_id = t.id AND i.result = 'not_met') AS n_not
           FROM tracers t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN mock_surveys m ON m.id = t.survey_id ORDER BY t.id DESC LIMIT 300`,
      ).all(),
      env.DB.prepare('SELECT framework, code, name_ar, name_en FROM std_chapters WHERE active = 1 ORDER BY framework, sort, code').all(),
      env.DB.prepare(
        `SELECT id, name, name_en FROM users WHERE active = 1 AND (quality_role IN ('manager', 'assessor') OR role IN ('super_admin', 'systems_admin')) ORDER BY name`,
      ).all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
    ]);
    const out = [];
    for (const sv of surveys) {
      const r = await surveyResults(env, sv);
      out.push({ ...sv, chapters: chaptersOf(sv.chapters), pct: r.total.pct, gaps: r.gaps, esr_gap: r.total.esr_gap, scored: r.scored, units: r.units });
    }
    return json({
      surveys: out,
      tracers,
      frameworks: fwOn(settings).map((k) => ({ key: k, ...FRAMEWORKS[k] })),
      chapters,
      people,
      departments,
      topics: TRACER_TOPICS,
      can_manage: role.manager,
      can_trace: role.officer,
      today,
    });
  }

  if (method === 'POST' && seg.length === 1) {
    needManager();
    const n = await readHead(null);
    const now = nowIso();
    const code = await nextCode(env, 'mock_surveys', 'MS');
    const res = await env.DB.prepare(
      `INSERT INTO mock_surveys (code, title, framework, chapters, start_on, end_on, status, created_by_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(code, n.title, n.framework, n.chapters, n.start_on, n.end_on, user.id, user.name, now, now).run();
    const id = res.meta.last_row_id;
    await env.DB.batch([...assignStmts(id, n), logStmt(env, user, 'create', 'mock', id, code + ' ' + n.title)]);
    return json({ ok: true, id, code });
  }

  const id = toId(seg[1]);
  const sv = id ? await env.DB.prepare('SELECT * FROM mock_surveys WHERE id = ?').bind(id).first() : null;
  if (!sv) fail(404, 'not_found');
  const active = sv.status === 'active';
  const { results: assigned } = await env.DB.prepare(
    'SELECT a.chapter, a.user_id, u.name, u.name_en FROM mock_assign a LEFT JOIN users u ON u.id = a.user_id WHERE a.survey_id = ?',
  ).bind(id).all();
  const who = Object.fromEntries(assigned.map((a) => [a.chapter, a]));
  // The manager scores any chapter; an assessor the chapters given to them, and any chapter given to nobody.
  const canScore = (ch) => active && (role.manager || (role.officer && (!who[ch] || who[ch].user_id === user.id)));

  // The survey: chapters with who scores them and their results, the previous survey to compare, its tracers.
  if (method === 'GET' && seg.length === 2) {
    const [r, prev, { results: tracers }, { results: names }] = await Promise.all([
      surveyResults(env, sv),
      env.DB.prepare("SELECT * FROM mock_surveys WHERE framework = ? AND status = 'closed' AND id <> ? AND created_at < ? ORDER BY created_at DESC LIMIT 1").bind(sv.framework, id, sv.created_at).first(),
      env.DB.prepare(
        `SELECT t.*, d.name_ar AS dept_ar, d.name_en AS dept_en,
                (SELECT COUNT(*) FROM tracer_items i WHERE i.tracer_id = t.id) AS n_items,
                (SELECT COUNT(*) FROM tracer_items i WHERE i.tracer_id = t.id AND i.result = 'met') AS n_met,
                (SELECT COUNT(*) FROM tracer_items i WHERE i.tracer_id = t.id AND i.result = 'not_met') AS n_not
           FROM tracers t LEFT JOIN departments d ON d.id = t.department_id WHERE t.survey_id = ? ORDER BY t.id`,
      ).bind(id).all(),
      env.DB.prepare('SELECT code, name_ar, name_en FROM std_chapters WHERE framework = ?').bind(sv.framework).all(),
    ]);
    const pr = prev ? await surveyResults(env, prev) : null;
    const pmap = pr ? Object.fromEntries(pr.chapters.map((c) => [c.code, c.pct])) : {};
    const nm = Object.fromEntries(names.map((c) => [c.code, c]));
    const units = (ch) => r.stds.filter((s) => s.chapter === ch).flatMap((s) => (s.elements.length ? s.elements : [s]));
    return json({
      survey: { ...sv, chapters: chaptersOf(sv.chapters) },
      chapters: r.chapters.map((c) => ({
        ...c,
        name_ar: nm[c.code]?.name_ar || c.code,
        name_en: nm[c.code]?.name_en || c.code,
        user_id: who[c.code]?.user_id || null,
        user_name: who[c.code]?.name || null,
        user_name_en: who[c.code]?.name_en || null,
        scored: units(c.code).filter((u) => u.score).length,
        units: units(c.code).length,
        prev: pmap[c.code] ?? null,
        can_score: canScore(c.code),
      })),
      total: r.total,
      scored: r.scored,
      units: r.units,
      esr_gaps: r.esr_gaps,
      prev: prev ? { id: prev.id, code: prev.code, title: prev.title, pct: pr.total.pct, esr_gap: pr.total.esr_gap } : null,
      tracers,
      has_esr: !!FRAMEWORKS[sv.framework]?.esr,
      can_manage: role.manager,
      can_trace: role.officer && active,
    });
  }

  // One chapter's standards for the scoring page, carrying the survey's scores instead of the official ones.
  if (method === 'GET' && seg[2] === 'standards' && seg.length === 3) {
    const ch = str(url.searchParams.get('chapter') || '', 6).toUpperCase();
    if (!chaptersOf(sv.chapters).includes(ch)) fail(404, 'not_found');
    const stds = await surveyStandards(env, sv, ch);
    const can = canScore(ch);
    return json({
      survey: { id: sv.id, code: sv.code, title: sv.title, status: sv.status },
      framework: sv.framework,
      standards: stds.map((s) => ({ ...s, can_score: can })),
    });
  }

  // Saving one element's activities (or a standard's own, element 0) in the survey.
  if (method === 'PUT' && seg[2] === 'score' && seg.length === 3) {
    const body = await readJson(request);
    const sid = toId(body.standard_id);
    const std = sid ? await env.DB.prepare('SELECT * FROM standards WHERE id = ? AND framework = ? AND active = 1').bind(sid, sv.framework).first() : null;
    if (!std || !chaptersOf(sv.chapters).includes(std.chapter)) fail(404, 'not_found');
    if (!canScore(std.chapter)) fail(403, 'forbidden');
    const eid = Number(body.element_id) || 0;
    const { results: els } = await env.DB.prepare('SELECT id FROM std_elements WHERE standard_id = ?').bind(sid).all();
    if (eid ? !els.some((e) => e.id === eid) : els.length) fail(404, 'not_found');
    const list = (Array.isArray(body.activities) ? body.activities : []).slice(0, 10);
    if (!list.length) fail(400, 'std_no_activity');
    const acts = list.map((a) => ({
      kind: STD_ACTIVITIES.includes(a && a.kind) ? a.kind : fail(400, 'std_bad_activity'),
      score: a.score === null || a.score === undefined || a.score === '' ? null : STD_SCORES.includes(a.score) ? a.score : fail(400, 'std_bad_score'),
      note: str(a.note, 1000) || null,
    }));
    const escore = rollup(acts.map((a) => a.score), false);
    const enote = acts.map((a) => a.note).filter(Boolean).join(' · ').slice(0, 1000) || null;
    await env.DB.prepare(
      `INSERT INTO mock_scores (survey_id, standard_id, element_id, acts, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(survey_id, standard_id, element_id) DO UPDATE SET acts = excluded.acts, score = excluded.score, note = excluded.note, user_id = excluded.user_id, user_name = excluded.user_name, at = excluded.at`,
    ).bind(id, sid, eid, JSON.stringify(acts), escore, enote, user.id, user.name, nowIso()).run();
    const [s] = (await surveyStandards(env, sv, std.chapter)).filter((x) => x.id === sid);
    return json({ ok: true, element: { id: eid, score: escore, note: enote }, activities: acts.map((a, i) => ({ id: i + 1, ...a })), score: s ? s.score : null });
  }

  if (method === 'PUT' && seg.length === 2) {
    needManager();
    if (!active) fail(409, 'mock_closed');
    const n = await readHead(sv);
    await env.DB.batch([
      env.DB.prepare('UPDATE mock_surveys SET title = ?, chapters = ?, start_on = ?, end_on = ?, updated_at = ? WHERE id = ?').bind(n.title, n.chapters, n.start_on, n.end_on, nowIso(), id),
      ...assignStmts(id, n),
      logStmt(env, user, 'update', 'mock', id, sv.code),
    ]);
    return json({ ok: true });
  }

  // Closing: a CAPA for each standard with a gap, with what the team wrote.
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    needManager();
    if (!active) fail(409, 'mock_closed');
    const body = await readJson(request);
    const r = await surveyResults(env, sv);
    if (!r.scored) fail(400, 'mock_nothing_scored');
    const due = plusDays(today, CAPA_DAYS);
    let n = 0;
    for (const s of r.stds.filter((x) => x.score === 'partial' || x.score === 'not_met')) {
      const notes = s.elements.length ? s.elements.filter((e) => e.score === 'partial' || e.score === 'not_met').map((e) => e.num + ': ' + (e.note || '')).join('\n') : s.note || '';
      await addCapa(env, { source: 'mock', title: `${s.code} - ${sv.code}`, detail: notes.slice(0, 2000), department_id: s.department_id, chapter: sv.framework === 'cbahi' ? s.chapter : '', std_code: sv.framework === 'cbahi' ? s.code : null, due, by: user.name });
      n++;
    }
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE mock_surveys SET status = 'closed', result = ?, closed_at = ?, updated_at = ? WHERE id = ?").bind(str(body.result, 2000) || null, now, now, id),
      logStmt(env, user, 'close', 'mock', id, sv.code, { capa: n, readiness: r.total.pct }),
    ]);
    return json({ ok: true, capa: n });
  }

  // Applying a closed survey: its scores become the official self-assessment, with history.
  if (method === 'POST' && seg[2] === 'apply' && seg.length === 3) {
    needManager();
    if (active) fail(409, 'mock_not_closed');
    if (sv.applied_at) fail(409, 'mock_applied');
    const r = await surveyResults(env, sv);
    const now = nowIso();
    const esrOn = FRAMEWORKS[sv.framework]?.esr;
    const by = user.name + ' (' + sv.code + ')';
    const stmts = [];
    let n = 0;
    for (const s of r.stds) {
      if (s.elements.length) {
        const touched = s.elements.filter((e) => e.activities.length);
        if (!touched.length) continue;
        for (const e of touched) {
          stmts.push(env.DB.prepare('DELETE FROM std_activities WHERE element_id = ?').bind(e.id));
          e.activities.forEach((a, k) =>
            stmts.push(
              env.DB.prepare('INSERT INTO std_activities (standard_id, element_id, kind, score, note, assessed_at, assessed_by, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(s.id, e.id, a.kind, a.score, a.note, a.score ? now : null, a.score ? by : null, k + 1),
            ),
          );
          stmts.push(env.DB.prepare('UPDATE std_elements SET score = ?, note = ?, assessed_at = ?, assessed_by = ? WHERE id = ?').bind(e.score, e.note, e.score ? now : null, e.score ? by : null, e.id));
          if (e.score) stmts.push(env.DB.prepare('INSERT INTO std_assessments (standard_id, element_id, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(s.id, e.id, e.score, e.note, user.id, by, now));
        }
        const merged = s.elements.map((e) => (e.activities.length ? e.score : e.official));
        const score = rollup(merged, esrOn && s.esr);
        stmts.push(env.DB.prepare('UPDATE standards SET score = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?').bind(score, score ? now : null, score ? by : null, now, s.id));
        if (score) stmts.push(env.DB.prepare('INSERT INTO std_assessments (standard_id, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?)').bind(s.id, score, s.note, user.id, by, now));
        n++;
      } else if (s.score) {
        stmts.push(
          env.DB.prepare('UPDATE standards SET score = ?, note = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?').bind(s.score, s.note, now, by, now, s.id),
          env.DB.prepare('INSERT INTO std_assessments (standard_id, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?)').bind(s.id, s.score, s.note, user.id, by, now),
        );
        n++;
      }
    }
    stmts.push(env.DB.prepare('UPDATE mock_surveys SET applied_at = ?, applied_by = ?, updated_at = ? WHERE id = ?').bind(now, user.name, now, id), logStmt(env, user, 'apply', 'mock', id, sv.code, { standards: n }));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, standards: n });
  }

  if (method === 'DELETE' && seg.length === 2) {
    needManager();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM mock_scores WHERE survey_id = ?').bind(id),
      env.DB.prepare('DELETE FROM mock_assign WHERE survey_id = ?').bind(id),
      env.DB.prepare('UPDATE tracers SET survey_id = NULL WHERE survey_id = ?').bind(id),
      env.DB.prepare('DELETE FROM mock_surveys WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'mock', id, sv.code),
    ]);
    return json({ ok: true });
  }
  fail(404, 'not_found');
}

/* --------------------------------- tracers --------------------------------- */

export async function handleTracers(request, env, url, seg, method, user) {
  const role = surveyRole(user);
  if (!role.viewer) fail(403, 'forbidden');
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const deptName = async (did) => (did ? await env.DB.prepare('SELECT name_ar, name_en FROM departments WHERE id = ?').bind(did).first() : null);
  const templateRows = (key, station, did) => (TRACER_TEMPLATES[key] || []).map(([ar, en, ch]) => ({ q: ar + ' | ' + en, ch, station, did }));
  const insertItems = async (tid, rows) => {
    const r = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m, COUNT(*) AS n FROM tracer_items WHERE tracer_id = ?').bind(tid).first();
    if (r.n + rows.length > MAX_ITEMS) fail(400, 'tracer_too_many');
    await env.DB.batch(
      rows.map((x, k) => env.DB.prepare('INSERT INTO tracer_items (tracer_id, station, department_id, question, chapter, sort) VALUES (?, ?, ?, ?, ?, ?)').bind(tid, x.station || null, x.did || null, x.q, x.ch || null, r.m + k + 1)),
    );
  };

  if (method === 'POST' && seg.length === 1) {
    if (!role.officer) fail(403, 'forbidden');
    const body = await readJson(request);
    const kind = TRACER_KINDS.includes(body.kind) ? body.kind : fail(400, 'tracer_bad_kind');
    const topic = kind === 'system' ? (TRACER_TOPICS.includes(body.topic) ? body.topic : fail(400, 'tracer_bad_kind')) : null;
    const mrn = kind === 'patient' ? str(body.mrn, 30) || fail(400, 'tracer_mrn') : null;
    const did = toId(body.department_id);
    const d = await deptName(did);
    if (did && !d) fail(400, 'not_found');
    const sid = toId(body.survey_id);
    if (sid && !(await env.DB.prepare("SELECT 1 FROM mock_surveys WHERE id = ? AND status = 'active'").bind(sid).first())) fail(409, 'mock_closed');
    const now = nowIso();
    const code = await nextCode(env, 'tracers', 'TR');
    const res = await env.DB.prepare(
      `INSERT INTO tracers (code, survey_id, kind, topic, mrn, title, department_id, on_date, status, by_id, by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    ).bind(code, sid, kind, topic, mrn, str(body.title, 200) || null, did, optDate(body.on_date) || today, user.id, user.name, now, now).run();
    const id = res.meta.last_row_id;
    // A patient tracer starts at its first unit; a system tracer with its list.
    await insertItems(id, kind === 'patient' ? templateRows('patient', d ? d.name_ar + (d.name_en ? ' | ' + d.name_en : '') : null, did) : templateRows(topic, null, null));
    await logStmt(env, user, 'create', 'tracer', id, code).run();
    return json({ ok: true, id, code });
  }

  const id = toId(seg[1]);
  const tr = id
    ? await env.DB.prepare('SELECT t.*, d.name_ar AS dept_ar, d.name_en AS dept_en, m.code AS survey_code, m.title AS survey_title FROM tracers t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN mock_surveys m ON m.id = t.survey_id WHERE t.id = ?').bind(id).first()
    : null;
  if (!tr) fail(404, 'not_found');
  const open = tr.status === 'open';
  const canEdit = open && (role.manager || (role.officer && tr.by_id === user.id));

  if (method === 'GET' && seg.length === 2) {
    const [{ results: items }, { results: departments }] = await Promise.all([
      env.DB.prepare('SELECT * FROM tracer_items WHERE tracer_id = ? ORDER BY sort, id').bind(id).all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
    ]);
    return json({ tracer: tr, items, departments, can_edit: canEdit, can_manage: role.manager });
  }

  // A line answered: met, not met (with a word on what is missing) or n/a.
  if (method === 'PUT' && seg[2] === 'items' && toId(seg[3]) && seg.length === 4) {
    if (!canEdit) fail(403, 'forbidden');
    const body = await readJson(request);
    const result = body.result === null || body.result === '' ? null : TRACER_RESULTS.includes(body.result) ? body.result : fail(400, 'std_bad_score');
    const r = await env.DB.prepare('UPDATE tracer_items SET result = ?, note = ? WHERE id = ? AND tracer_id = ?').bind(result, str(body.note, 1000) || null, toId(seg[3]), id).run();
    if (!r.meta.changes) fail(404, 'not_found');
    await env.DB.prepare('UPDATE tracers SET updated_at = ? WHERE id = ?').bind(nowIso(), id).run();
    return json({ ok: true });
  }

  // The next station on a patient's path (the questions again), or one question of the tracer's own.
  if (method === 'POST' && seg[2] === 'items' && seg.length === 3) {
    if (!canEdit) fail(403, 'forbidden');
    const body = await readJson(request);
    const did = toId(body.department_id);
    const d = await deptName(did);
    if (did && !d) fail(400, 'not_found');
    const station = d ? d.name_ar + (d.name_en ? ' | ' + d.name_en : '') : str(body.station, 120) || null;
    const q = str(body.question, 500);
    if (q) await insertItems(id, [{ q, ch: str(body.chapter, 6).toUpperCase() || null, station, did }]);
    else if (tr.kind === 'patient' && station) await insertItems(id, templateRows('patient', station, did));
    else fail(400, 'name_required');
    return json({ ok: true });
  }

  if (method === 'DELETE' && seg[2] === 'items' && toId(seg[3]) && seg.length === 4) {
    if (!canEdit) fail(403, 'forbidden');
    await env.DB.prepare('DELETE FROM tracer_items WHERE id = ? AND tracer_id = ?').bind(toId(seg[3]), id).run();
    return json({ ok: true });
  }

  // Done: every line answered, a gap explained; a CAPA for each line not met.
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    if (!canEdit) fail(403, 'forbidden');
    const body = await readJson(request);
    const { results: items } = await env.DB.prepare('SELECT * FROM tracer_items WHERE tracer_id = ? ORDER BY sort, id').bind(id).all();
    if (!items.length || items.some((i) => !i.result)) fail(400, 'tracer_open_items');
    if (items.some((i) => i.result === 'not_met' && !i.note)) fail(400, 'std_gap_note');
    const due = plusDays(today, CAPA_DAYS);
    const stmts = [];
    for (const i of items.filter((x) => x.result === 'not_met')) {
      const q = i.question.split(' | ')[0];
      const cid = await addCapa(env, { source: 'tracer', title: `${q} - ${tr.code}`, detail: [i.station ? i.station.split(' | ')[0] : '', i.note].filter(Boolean).join(': '), department_id: i.department_id || tr.department_id, chapter: i.chapter, due, by: user.name });
      stmts.push(env.DB.prepare('UPDATE tracer_items SET capa_id = ? WHERE id = ?').bind(cid, i.id));
    }
    const now = nowIso();
    stmts.push(
      env.DB.prepare("UPDATE tracers SET status = 'done', summary = ?, closed_at = ?, updated_at = ? WHERE id = ?").bind(str(body.summary, 2000) || null, now, now, id),
      logStmt(env, user, 'close', 'tracer', id, tr.code),
    );
    await env.DB.batch(stmts);
    return json({ ok: true, capa: stmts.length - 2 });
  }

  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager && !(open && tr.by_id === user.id)) fail(403, 'forbidden');
    await env.DB.batch([env.DB.prepare('DELETE FROM tracer_items WHERE tracer_id = ?').bind(id), env.DB.prepare('DELETE FROM tracers WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'tracer', id, tr.code)]);
    return json({ ok: true });
  }
  fail(404, 'not_found');
}

// For the quality report: the last closed survey, and the tracers done in the period.
export async function surveySnapshot(env, from, to) {
  const sv = await env.DB.prepare("SELECT * FROM mock_surveys WHERE status = 'closed' AND substr(closed_at, 1, 10) <= ? ORDER BY closed_at DESC LIMIT 1").bind(to).first();
  const r = sv ? await surveyResults(env, sv) : null;
  const t = await env.DB.prepare(
    `SELECT COUNT(DISTINCT t.id) AS n, COALESCE(SUM(i.result = 'met'), 0) AS met, COALESCE(SUM(i.result = 'not_met'), 0) AS not_met
       FROM tracers t LEFT JOIN tracer_items i ON i.tracer_id = t.id WHERE t.status = 'done' AND substr(t.closed_at, 1, 10) BETWEEN ? AND ?`,
  ).bind(from, to).first();
  const base = (t.met || 0) + (t.not_met || 0);
  return {
    survey: sv ? { id: sv.id, code: sv.code, title: sv.title, framework: sv.framework, pct: r.total.pct, esr_gap: r.total.esr_gap, gaps: r.gaps } : null,
    tracers: { n: t.n || 0, pct: base ? Math.round(((t.met || 0) / base) * 100) : null },
  };
}

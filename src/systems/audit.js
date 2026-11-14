// Clinical audits: a topic and its reference, criteria each with a target, and a sample of cases (record number only,
// never patient details) answered yes / no / n/a per criterion. Compliance = yes / (yes + no), per criterion and overall.
// Closing opens the improvement (a CAPA for each criterion below target, or one PDSA project); a re-audit repeats the
// criteria to show the change. An audit tied to an indicator writes the month's compliance into it.
import { readJson } from '../lib/auth.js';
import { getSettings, logStmt } from '../lib/db.js';
import { fail, json, nowIso, optDate, str, todayIn } from '../lib/util.js';
import { CAPA_DAYS } from './capa.js';
import { plusDays } from './docs.js';
import { periodOf } from './kpis.js';
import { nextPdsaCode } from './qplan.js';
import { riskRole } from './risk.js';

export const AUDIT_ANSWERS = ['y', 'n', 'na'];
const MAX_CRITERIA = 30;

// Ready audits: [key, Arabic, English, chapter, [[criterion Arabic, English, target]]]. The hospital's own wording.
export const AUDIT_LIBRARY = [
  ['allergy', 'توثيق الحساسية', 'Allergy documentation', 'MM', [
    ['حالة الحساسية موثقة عند الدخول', 'Allergy status documented on admission', 95],
    ['نوع الحساسية ورد الفعل موثقان', 'Allergen and reaction documented', 90],
    ['سوار أو تنبيه الحساسية مطبق', 'Allergy band or alert in place', 95],
    ['الحساسية ظاهرة في سجل إعطاء الأدوية', 'Allergy shown on the medication record', 95],
  ]],
  ['consent', 'الموافقة المستنيرة', 'Informed consent', null, [
    ['الموافقة موقعة قبل الإجراء', 'Consent signed before the procedure', 100],
    ['اسم الإجراء واضح دون اختصارات', 'Procedure named clearly, no abbreviations', 95],
    ['المخاطر والبدائل موثقة', 'Risks and alternatives documented', 90],
    ['توقيع الطبيب والمريض أو وليه مع التاريخ والوقت', 'Signed by physician and patient or guardian with date and time', 95],
    ['توقيع الشاهد موجود', 'Witness signature present', 90],
  ]],
  ['falls', 'تقييم خطر السقوط', 'Fall risk assessment', 'NR', [
    ['التقييم خلال 24 ساعة من الدخول', 'Assessed within 24 hours of admission', 95],
    ['إعادة التقييم حسب السياسة', 'Reassessed as the policy requires', 90],
    ['إجراءات الوقاية مطبقة لعالي الخطورة', 'Prevention measures in place for high risk', 90],
    ['المريض وأسرته تلقوا التثقيف', 'Patient and family educated', 85],
  ]],
  ['timeout', 'الوقفة الجراحية', 'Surgical time-out', null, [
    ['الوقفة تمت قبل الشق الجراحي', 'Time-out done before incision', 100],
    ['هوية المريض مؤكدة', 'Patient identity confirmed', 100],
    ['موضع العملية معلّم', 'Site marked', 100],
    ['الإجراء مؤكد', 'Procedure confirmed', 100],
    ['كل الفريق شارك', 'Whole team took part', 100],
    ['موثقة مع الوقت', 'Documented with the time', 95],
  ]],
  ['prophylaxis', 'المضاد الوقائي للعمليات', 'Surgical antibiotic prophylaxis', 'IPC', [
    ['المضاد مستطب حسب الدليل', 'Indicated by the guideline', 95],
    ['أُعطي خلال 60 دقيقة قبل الشق', 'Given within 60 minutes before incision', 90],
    ['الدواء والجرعة صحيحان', 'Right drug and dose', 95],
    ['أُوقف خلال 24 ساعة', 'Stopped within 24 hours', 85],
  ]],
  ['medrec', 'مطابقة الأدوية', 'Medication reconciliation', 'MM', [
    ['قائمة أدوية المنزل موثقة عند الدخول', 'Home medication list documented on admission', 95],
    ['المطابقة خلال 24 ساعة', 'Reconciled within 24 hours', 90],
    ['الفروقات تمت معالجتها', 'Discrepancies resolved', 90],
    ['المطابقة عند الخروج', 'Reconciled at discharge', 90],
  ]],
];

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const parseAnswers = (v) => {
  try {
    const a = JSON.parse(v || '{}');
    return a && typeof a === 'object' ? a : {};
  } catch {
    return {};
  }
};

export async function auditAccess(env, u) {
  const r = riskRole(u);
  if (r.manager) return 'manager';
  if (r.officer) return 'officer';
  if (r.viewer) return 'viewer';
  if (r.dept) return 'dept';
  const x = await env.DB.prepare("SELECT 1 AS x FROM audits WHERE status = 'active' AND owner_id = ? LIMIT 1").bind(u.id).first();
  return x ? 'member' : 'none';
}

// Each criterion's yes / no / n/a and compliance, and the audit's overall compliance.
export function auditResults(criteria, cases) {
  const rows = criteria.map((c) => ({ ...c, yes: 0, no: 0, na: 0 }));
  const by = Object.fromEntries(rows.map((c) => [c.id, c]));
  for (const k of cases) {
    const a = parseAnswers(k.answers);
    for (const [cid, v] of Object.entries(a)) if (by[cid] && AUDIT_ANSWERS.includes(v)) by[cid][v === 'y' ? 'yes' : v === 'n' ? 'no' : 'na']++;
  }
  let y = 0;
  let base = 0;
  for (const c of rows) {
    c.pct = c.yes + c.no ? Math.round((c.yes / (c.yes + c.no)) * 100) : null;
    c.met = c.pct === null ? null : c.pct >= c.target;
    y += c.yes;
    base += c.yes + c.no;
  }
  return { criteria: rows, pct: base ? Math.round((y / base) * 100) : null, cases: cases.length };
}

// The indicator tied to audits gets each period's compliance from all of their cases.
async function syncKpi(env, kpiId, user) {
  if (!kpiId) return;
  const k = await env.DB.prepare("SELECT * FROM kpis WHERE id = ? AND source = 'manual' AND unit = 'pct'").bind(kpiId).first();
  if (!k) return;
  const { results } = await env.DB.prepare('SELECT c.case_date, c.answers FROM audit_cases c JOIN audits a ON a.id = c.audit_id WHERE a.kpi_id = ?').bind(kpiId).all();
  const per = {};
  for (const c of results) {
    const p = periodOf(c.case_date, k.frequency);
    const t = (per[p] = per[p] || { y: 0, d: 0 });
    for (const v of Object.values(parseAnswers(c.answers))) {
      if (v === 'y') t.y++;
      if (v === 'y' || v === 'n') t.d++;
    }
  }
  const now = nowIso();
  const stmts = Object.entries(per)
    .filter(([, t]) => t.d)
    .map(([p, t]) =>
      env.DB.prepare(
        `INSERT INTO kpi_values (kpi_id, period, num, den, note, entered_by, entered_at) VALUES (?, ?, ?, ?, 'audit', ?, ?)
         ON CONFLICT(kpi_id, period) DO UPDATE SET num = excluded.num, den = excluded.den, note = excluded.note, entered_by = excluded.entered_by, entered_at = excluded.entered_at`,
      ).bind(kpiId, p, t.y, t.d, user.name, now),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

const SELECT = `SELECT a.*, d.name_ar AS dept_ar, d.name_en AS dept_en, u.name AS owner_name, u.name_en AS owner_name_en, k.code AS kpi_code
  FROM audits a LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN kpis k ON k.id = a.kpi_id`;

export async function handleAudits(request, env, url, seg, method, user) {
  const access = await auditAccess(env, user);
  if (access === 'none') fail(403, 'forbidden');
  const role = riskRole(user);
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  // Quality sees every audit; a department head their department's; an owner their own.
  const canSee = (a) => role.viewer || (role.dept && a.department_id === role.dept) || a.owner_id === user.id;
  const canRun = (a) => role.officer || (role.dept && a.department_id === role.dept);
  const canEnter = (a) => a.status === 'active' && (canRun(a) || a.owner_id === user.id);

  const readHead = async (old) => {
    const body = await readJson(request);
    const n = {
      title: str(body.title, 200),
      reference: str(body.reference, 500) || null,
      department_id: toId(body.department_id),
      owner_id: toId(body.owner_id),
      chapter: str(body.chapter, 6).toUpperCase() || null,
      period_from: optDate(body.period_from),
      period_to: optDate(body.period_to),
      sample: toId(body.sample),
      kpi_id: toId(body.kpi_id),
      library: str(body.library, 20) || (old ? old.library : null),
    };
    if (!n.title) fail(400, 'name_required');
    if (n.period_from && n.period_to && n.period_to < n.period_from) fail(400, 'pdsa_bad_dates');
    if (role.dept && !role.officer) n.department_id = role.dept;
    if (n.kpi_id && !(await env.DB.prepare('SELECT 1 FROM kpis WHERE id = ?').bind(n.kpi_id).first())) n.kpi_id = null;
    const list = Array.isArray(body.criteria) ? body.criteria.slice(0, MAX_CRITERIA) : null;
    n.criteria = list
      ? list
          .map((c) => ({ id: toId(c && c.id), text: str(c && c.text, 500), target: Math.max(0, Math.min(100, Number(c && c.target) || 0)) || 90 }))
          .filter((c) => c.text)
      : null;
    if (!old && (!n.criteria || !n.criteria.length)) fail(400, 'audit_no_criteria');
    return n;
  };

  if (method === 'GET' && seg.length === 1) {
    const [{ results: audits }, { results: crit }, { results: cases }, { results: departments }, { results: people }, { results: kpis }, { results: chapters }] = await Promise.all([
      env.DB.prepare(`${SELECT} ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.id DESC LIMIT 500`).all(),
      env.DB.prepare('SELECT * FROM audit_criteria ORDER BY audit_id, n').all(),
      env.DB.prepare('SELECT audit_id, answers FROM audit_cases').all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
      env.DB.prepare('SELECT id, name, name_en FROM users WHERE active = 1 AND id <> (SELECT MIN(id) FROM users) ORDER BY name').all(),
      env.DB.prepare("SELECT id, code, name_ar, name_en FROM kpis WHERE active = 1 AND unit = 'pct' AND source = 'manual' ORDER BY code").all(),
      env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' AND active = 1 ORDER BY sort, code").all(),
    ]);
    const cBy = {};
    for (const c of crit) (cBy[c.audit_id] = cBy[c.audit_id] || []).push(c);
    const kBy = {};
    for (const k of cases) (kBy[k.audit_id] = kBy[k.audit_id] || []).push(k);
    const list = audits.filter(canSee).map((a) => {
      const r = auditResults(cBy[a.id] || [], kBy[a.id] || []);
      return { ...a, pct: r.pct, n_cases: r.cases, below: r.criteria.filter((c) => c.met === false).length };
    });
    return json({
      audits: list,
      library: AUDIT_LIBRARY.map(([key, ar, en, chapter, items]) => ({ key, title_ar: ar, title_en: en, chapter, criteria: items.map(([a, e, target]) => ({ text: a + ' | ' + e, target })) })),
      departments,
      people,
      kpis,
      chapters,
      can_add: role.officer || !!role.dept,
      dept_only: !role.officer && role.dept ? role.dept : null,
      today,
    });
  }

  if (method === 'POST' && seg.length === 1) {
    if (!role.officer && !role.dept) fail(403, 'forbidden');
    const n = await readHead(null);
    const now = nowIso();
    const code = await nextCode(env);
    const res = await env.DB.prepare(
      `INSERT INTO audits (code, title, reference, department_id, owner_id, chapter, period_from, period_to, sample, status, n_round, kpi_id, library, created_by_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?), ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(code, n.title, n.reference, n.department_id, n.owner_id || user.id, n.chapter || '', n.period_from, n.period_to, n.sample, n.kpi_id, n.library, user.id, user.name, now, now).run();
    const id = res.meta.last_row_id;
    await env.DB.batch([
      ...n.criteria.map((c, k) => env.DB.prepare('INSERT INTO audit_criteria (audit_id, n, text, target) VALUES (?, ?, ?, ?)').bind(id, k + 1, c.text, c.target)),
      logStmt(env, user, 'create', 'audit', id, code + ' ' + n.title),
    ]);
    return json({ ok: true, id, code });
  }

  const id = toId(seg[1]);
  const a = id ? await env.DB.prepare(`${SELECT} WHERE a.id = ?`).bind(id).first() : null;
  if (!a || !canSee(a)) fail(404, 'not_found');
  const load = async (aid) => {
    const [{ results: criteria }, { results: cases }] = await Promise.all([
      env.DB.prepare('SELECT * FROM audit_criteria WHERE audit_id = ? ORDER BY n').bind(aid).all(),
      env.DB.prepare('SELECT * FROM audit_cases WHERE audit_id = ? ORDER BY case_date DESC, id DESC').bind(aid).all(),
    ]);
    return { criteria, cases };
  };

  // The audit with its results, its cases and the audit before it (for a re-audit), criterion by criterion.
  if (method === 'GET' && seg.length === 2) {
    const { criteria, cases } = await load(id);
    const r = auditResults(criteria, cases);
    let prev = null;
    if (a.parent_id) {
      const p = await env.DB.prepare('SELECT * FROM audits WHERE id = ?').bind(a.parent_id).first();
      if (p) {
        const pl = await load(p.id);
        const pr = auditResults(pl.criteria, pl.cases);
        prev = { id: p.id, code: p.code, n_round: p.n_round, pct: pr.pct, criteria: Object.fromEntries(pr.criteria.map((c) => [c.n, c.pct])) };
      }
    }
    const next = await env.DB.prepare('SELECT id, code FROM audits WHERE parent_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
    return json({
      audit: a,
      ...r,
      list: cases.map((c) => ({ ...c, answers: parseAnswers(c.answers) })),
      prev,
      next,
      can_enter: canEnter(a),
      can_edit: a.status === 'active' && canRun(a),
      can_close: a.status === 'active' && canRun(a),
      can_reaudit: a.status === 'done' && canRun(a) && !next,
      can_delete: role.manager,
    });
  }

  if (method === 'PUT' && seg.length === 2) {
    if (!(a.status === 'active' && canRun(a))) fail(403, 'forbidden');
    const n = await readHead(a);
    const stmts = [
      env.DB.prepare(
        `UPDATE audits SET title = ?, reference = ?, department_id = ?, owner_id = ?, chapter = (SELECT code FROM std_chapters WHERE framework = 'cbahi' AND code = ?), period_from = ?, period_to = ?, sample = ?, kpi_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(n.title, n.reference, n.department_id, n.owner_id || a.owner_id, n.chapter || '', n.period_from, n.period_to, n.sample, n.kpi_id, nowIso(), id),
    ];
    // Criteria: wording and targets can change; adding or removing them only before the first case.
    if (n.criteria) {
      if (!n.criteria.length) fail(400, 'audit_no_criteria');
      const { criteria: had } = await load(id);
      const hasCases = await env.DB.prepare('SELECT 1 FROM audit_cases WHERE audit_id = ? LIMIT 1').bind(id).first();
      const keep = new Set(n.criteria.map((c) => c.id).filter(Boolean));
      if (hasCases && (had.some((c) => !keep.has(c.id)) || n.criteria.some((c) => !c.id))) fail(409, 'audit_has_cases');
      for (const c of had) if (!keep.has(c.id)) stmts.push(env.DB.prepare('DELETE FROM audit_criteria WHERE id = ?').bind(c.id));
      n.criteria.forEach((c, k) =>
        stmts.push(
          c.id && had.some((x) => x.id === c.id)
            ? env.DB.prepare('UPDATE audit_criteria SET n = ?, text = ?, target = ? WHERE id = ?').bind(k + 1, c.text, c.target, c.id)
            : env.DB.prepare('INSERT INTO audit_criteria (audit_id, n, text, target) VALUES (?, ?, ?, ?)').bind(id, k + 1, c.text, c.target),
        ),
      );
    }
    stmts.push(logStmt(env, user, 'update', 'audit', id, a.code));
    await env.DB.batch(stmts);
    if (n.kpi_id !== a.kpi_id) await Promise.all([syncKpi(env, n.kpi_id, user), syncKpi(env, a.kpi_id, user)]);
    return json({ ok: true });
  }

  // A case: the record number, the date, and each criterion's answer.
  const readCase = async (criteria) => {
    const body = await readJson(request);
    const mrn = str(body.mrn, 30);
    if (!mrn) fail(400, 'tracer_mrn');
    const case_date = optDate(body.case_date) || today;
    const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
    const answers = {};
    for (const c of criteria) {
      const v = given[c.id];
      if (!AUDIT_ANSWERS.includes(v)) fail(400, 'audit_answer_all');
      answers[c.id] = v;
    }
    return { mrn, case_date, answers: JSON.stringify(answers), note: str(body.note, 1000) || null };
  };

  if (method === 'POST' && seg[2] === 'cases' && seg.length === 3) {
    if (!canEnter(a)) fail(403, 'forbidden');
    const { criteria } = await load(id);
    const c = await readCase(criteria);
    const res = await env.DB.prepare('INSERT INTO audit_cases (audit_id, mrn, case_date, answers, note, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, c.mrn, c.case_date, c.answers, c.note, user.id, user.name, nowIso())
      .run();
    await syncKpi(env, a.kpi_id, user);
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if ((method === 'PUT' || method === 'DELETE') && seg[2] === 'cases' && toId(seg[3]) && seg.length === 4) {
    if (!canEnter(a)) fail(403, 'forbidden');
    const cid = toId(seg[3]);
    const old = await env.DB.prepare('SELECT * FROM audit_cases WHERE id = ? AND audit_id = ?').bind(cid, id).first();
    if (!old) fail(404, 'not_found');
    if (!canRun(a) && old.by_id !== user.id) fail(403, 'forbidden');
    if (method === 'DELETE') await env.DB.prepare('DELETE FROM audit_cases WHERE id = ?').bind(cid).run();
    else {
      const { criteria } = await load(id);
      const c = await readCase(criteria);
      await env.DB.prepare('UPDATE audit_cases SET mrn = ?, case_date = ?, answers = ?, note = ? WHERE id = ?').bind(c.mrn, c.case_date, c.answers, c.note, cid).run();
    }
    await syncKpi(env, a.kpi_id, user);
    return json({ ok: true });
  }

  // Closing with the improvement: a CAPA for each criterion below target, or one PDSA project, or none.
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    if (!(a.status === 'active' && canRun(a))) fail(403, 'forbidden');
    const body = await readJson(request);
    const plan = ['capa', 'pdsa', 'none'].includes(body.plan) ? body.plan : 'none';
    const { criteria, cases } = await load(id);
    if (!cases.length) fail(400, 'audit_no_cases');
    const r = auditResults(criteria, cases);
    const below = r.criteria.filter((c) => c.met === false);
    const now = nowIso();
    let made = 0;
    let pdsaId = null;
    if (plan === 'capa') {
      const due = plusDays(today, CAPA_DAYS);
      for (const c of below) {
        await env.DB.prepare(
          `INSERT INTO capa (source, title, detail, department_id, chapter, due, status, created_by, created_at, updated_at) VALUES ('audit', ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        ).bind((c.text.split(' | ')[0] + ' - ' + a.code).slice(0, 500), `${c.pct}% / ${c.target}%`, a.department_id, a.chapter, due, user.name, now, now).run();
        made++;
      }
    }
    if (plan === 'pdsa' && below.length) {
      const code = await nextPdsaCode(env);
      const res = await env.DB.prepare(
        `INSERT INTO pdsa (code, title, problem, aim, department_id, leader_id, team, kpi_id, baseline, target, start_on, status, source, source_ref, created_by_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ',', ?, ?, ?, ?, 'active', 'audit', ?, ?, ?, ?, ?)`,
      ).bind(
        code,
        a.title.slice(0, 200),
        below.map((c) => `${c.text.split(' | ')[0]}: ${c.pct}%`).join('\n').slice(0, 2000),
        null,
        a.department_id,
        a.owner_id || user.id,
        a.kpi_id,
        r.pct,
        Math.max(...below.map((c) => c.target)),
        today,
        id,
        user.id,
        user.name,
        now,
        now,
      ).run();
      pdsaId = res.meta.last_row_id;
      made = 1;
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE audits SET status = 'done', result = ?, plan = ?, closed_at = ?, updated_at = ? WHERE id = ?").bind(str(body.result, 2000) || null, made ? plan : 'none', now, now, id),
      logStmt(env, user, 'close', 'audit', id, a.code, { pct: r.pct, plan, made }),
    ]);
    return json({ ok: true, made, pdsa_id: pdsaId });
  }

  // A re-audit: the same criteria, a new sample, compared with this one.
  if (method === 'POST' && seg[2] === 'reaudit' && seg.length === 3) {
    if (!(a.status === 'done' && canRun(a))) fail(403, 'forbidden');
    if (await env.DB.prepare('SELECT 1 FROM audits WHERE parent_id = ?').bind(id).first()) fail(409, 'audit_reaudited');
    const { criteria } = await load(id);
    const now = nowIso();
    const code = await nextCode(env);
    const res = await env.DB.prepare(
      `INSERT INTO audits (code, title, reference, department_id, owner_id, chapter, sample, status, parent_id, n_round, kpi_id, library, created_by_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(code, a.title, a.reference, a.department_id, a.owner_id, a.chapter, a.sample, id, a.n_round + 1, a.kpi_id, a.library, user.id, user.name, now, now).run();
    const nid = res.meta.last_row_id;
    await env.DB.batch([
      ...criteria.map((c) => env.DB.prepare('INSERT INTO audit_criteria (audit_id, n, text, target) VALUES (?, ?, ?, ?)').bind(nid, c.n, c.text, c.target)),
      logStmt(env, user, 'create', 'audit', nid, code + ' ← ' + a.code),
    ]);
    return json({ ok: true, id: nid, code });
  }

  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM audit_cases WHERE audit_id = ?').bind(id),
      env.DB.prepare('DELETE FROM audit_criteria WHERE audit_id = ?').bind(id),
      env.DB.prepare('UPDATE audits SET parent_id = NULL WHERE parent_id = ?').bind(id),
      env.DB.prepare('DELETE FROM audits WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'audit', id, a.code),
    ]);
    await syncKpi(env, a.kpi_id, user);
    return json({ ok: true });
  }
  fail(404, 'not_found');
}

async function nextCode(env) {
  const r = await env.DB.prepare("SELECT MAX(CAST(substr(code, 4) AS INTEGER)) AS m FROM audits WHERE code LIKE 'CA-%'").first();
  return 'CA-' + String((r.m || 0) + 1).padStart(3, '0');
}

// For the quality report: audits closed in the period and their compliance.
export async function auditSnapshot(env, from, to) {
  const { results } = await env.DB.prepare("SELECT id, code, title, n_round FROM audits WHERE status = 'done' AND substr(closed_at, 1, 10) BETWEEN ? AND ? ORDER BY closed_at").bind(from, to).all();
  const out = [];
  for (const a of results) {
    const [{ results: criteria }, { results: cases }] = await Promise.all([
      env.DB.prepare('SELECT * FROM audit_criteria WHERE audit_id = ?').bind(a.id).all(),
      env.DB.prepare('SELECT answers FROM audit_cases WHERE audit_id = ?').bind(a.id).all(),
    ]);
    const r = auditResults(criteria, cases);
    out.push({ ...a, pct: r.pct, below: r.criteria.filter((c) => c.met === false).length });
  }
  return out;
}

// Quality & Accreditation: the standards frameworks (CBAHI, JCI, CHI), their chapters and standards, the
// self-assessment and the readiness score. Each framework keeps its own codes and chapters; a CBAHI standard
// can still name the JCI standards it matches. The texts come into each hospital's own database from an
// import pack: they are licensed to the hospital, so they are never part of this code.
import { readJson } from '../lib/auth.js';
import { isAdmin } from '../lib/config.js';
import { getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { ARABIC_RE, fail, json, nowIso, str, todayIn } from '../lib/util.js';
import { route2 } from './assets.js';
import { capaHome } from './capa.js';
import { fileOut } from './docs.js';
import { fmsEvidence, portalDocUrl, portalDocsOn } from './fmslink.js';

// met = fully met, partial = partially met, not_met, na = not applicable to this hospital.
export const STD_SCORES = ['met', 'partial', 'not_met', 'na'];
// How the surveyor checks a sub-standard: reads a document, looks at the place, asks the staff.
export const STD_ACTIVITIES = ['document', 'observation', 'interview'];

// The chapters a hospital starts with. ESR is not a chapter: it is a flag on standards in any chapter.
// Names and the JCI mapping can be changed from the Chapters page; new chapters can be added.
export const STARTER_CHAPTERS = [
  ['LD', 'القيادة', 'Leadership', 'GLD', 1],
  ['QM', 'إدارة الجودة وسلامة المرضى', 'Quality Management & Patient Safety', 'QPS', 2],
  ['MM', 'إدارة الأدوية', 'Medication Management', 'MMU', 3],
  ['FMS', 'إدارة المرافق والسلامة', 'Facility Management & Safety', 'FMS', 4],
  ['IPC', 'الوقاية من العدوى ومكافحتها', 'Infection Prevention & Control', 'PCI', 5],
  ['NR', 'الرعاية التمريضية', 'Nursing Care', 'COP', 6],
  ['LB', 'المختبر', 'Laboratory', 'AOP', 7],
  ['MS', 'الطاقم الطبي', 'Medical Staff', 'SQE', 8],
];

// The frameworks. CBAHI and CHI score sub-standards, JCI scores measurable elements (MEs). On CBAHI an ESR
// (Essential Safety Requirement) is all or nothing: partly met counts as not met.
export const FRAMEWORKS = {
  cbahi: { name_ar: 'سباهي', name_en: 'CBAHI', esr: true },
  jci: { name_ar: 'اللجنة الدولية المشتركة', name_en: 'JCI', esr: false },
  chi: { name_ar: 'مجلس الضمان الصحي', name_en: 'CHI', esr: false },
};
const FW_KEYS = Object.keys(FRAMEWORKS);
export const fwOn = (settings) => {
  const on = String(settings.std_frameworks || 'cbahi').split(',').map((x) => x.trim()).filter((x) => FW_KEYS.includes(x));
  return on.length ? on : ['cbahi'];
};
const readFw = (v, settings) => {
  const f = str(v || '', 10).toLowerCase() || fwOn(settings)[0];
  if (!FW_KEYS.includes(f)) fail(400, 'std_bad_framework');
  return f;
};

// CBAHI's Labor and Delivery chapter is "L&D".
const CODE_RE = /^[A-Z&]{2,6}$/;
const STD_CODE_RE = /^[A-Za-z&]{2,6}[A-Za-z0-9.\-]{0,20}$/;
// Readiness: met counts 1, partial counts a half, not applicable is left out, not yet assessed counts 0.
export const readiness = (r) => {
  const base = (r.n || 0) - (r.na || 0);
  return base > 0 ? Math.round((((r.met || 0) + (r.partial || 0) / 2) / base) * 100) : null;
};
const STATS = `COUNT(*) AS n, COALESCE(SUM(score = 'met'), 0) AS met, COALESCE(SUM(score = 'partial'), 0) AS partial,
  COALESCE(SUM(score = 'not_met'), 0) AS not_met, COALESCE(SUM(score = 'na'), 0) AS na, COALESCE(SUM(score IS NULL), 0) AS open,
  COALESCE(SUM(esr = 1), 0) AS esr, COALESCE(SUM(esr = 1 AND score IN ('partial', 'not_met')), 0) AS esr_gap`;
const withPct = (r) => ({ ...r, pct: readiness(r) });

// The code's letters before the number: "LD.12" and "LD-12" are in LD.
export const chapterOf = (code) => (/^([A-Za-z&]{2,6})/.exec(code) || [])[1]?.toUpperCase() || '';

// A standard's score from its elements: all n/a is n/a, all met is met, all not met is not met, any mix is
// partly met. An ESR partly met is not met. Elements not yet scored leave the standard open.
export function rollup(scores, esr) {
  if (!scores.length || scores.some((x) => !x)) return null;
  const live = scores.filter((x) => x !== 'na');
  if (!live.length) return 'na';
  if (live.every((x) => x === 'met')) return 'met';
  if (live.every((x) => x === 'not_met')) return 'not_met';
  return esr ? 'not_met' : 'partial';
}

export async function seedChapters(env, settings) {
  if (settings.std_chapters_seeded === '1') return;
  await env.DB.batch([
    ...STARTER_CHAPTERS.map(([code, ar, en, jci, sort]) => env.DB.prepare('INSERT OR IGNORE INTO std_chapters (code, name_ar, name_en, jci, sort) VALUES (?, ?, ?, ?, ?)').bind(code, ar, en, jci, sort)),
    setSettingStmt(env, 'std_chapters_seeded', '1'),
  ]);
}

// The numbers on the portal's home card.
export async function qualityHome(env) {
  const settings = await getSettings(env);
  const fw = fwOn(settings)[0];
  const [r, capa] = await Promise.all([
    env.DB.prepare(`SELECT ${STATS} FROM standards WHERE active = 1 AND framework = ?`).bind(fw).first(),
    capaHome(env, todayIn(settings.timezone)),
  ]);
  return { pct: readiness(r), esr_gap: r.esr_gap || 0, open: r.open || 0, n: r.n || 0, capa_open: capa.open, capa_late: capa.late };
}

function readStandard(body, chapters, allowNoAr = false) {
  const code = str(body.code, 30).replace(/\s+/g, '');
  if (!STD_CODE_RE.test(code)) fail(400, 'std_bad_code');
  const chapter = (str(body.chapter, 6) || chapterOf(code)).toUpperCase();
  if (!chapters.has(chapter)) fail(400, 'std_bad_chapter');
  const title_ar = str(body.title_ar, 1000);
  const title_en = str(body.title_en, 1000);
  // A standard from an import pack can wait for its Arabic wording: the English text is shown until then.
  if (!title_en || (!title_ar && !allowNoAr)) fail(400, 'name_required');
  if (title_ar && !ARABIC_RE.test(title_ar)) fail(400, 'ar_needs_arabic');
  if (ARABIC_RE.test(title_en)) fail(400, 'std_en_arabic');
  const jci = str(body.jci, 200) || null;
  const esr = body.esr === true || body.esr === 1 || body.esr === '1' ? 1 : 0;
  const department_id = Number.isInteger(Number(body.department_id)) && body.department_id !== null && body.department_id !== '' ? Number(body.department_id) : null;
  return { code, chapter, title_ar, title_en, jci, esr, department_id };
}

export async function handleQuality(request, env, url, seg, method, user) {
  const role = user.quality || 'none';
  if (role === 'none') fail(403, 'forbidden');
  const manager = isAdmin(user) || role === 'manager';
  // An assessor with a department scores that department's standards and the ones no department owns.
  const canScore = (s) => manager || (role === 'assessor' && (!user.department_id || !s.department_id || s.department_id === user.department_id));
  const needManager = () => {
    if (!manager) fail(403, 'forbidden');
  };
  const settings = await getSettings(env);
  await seedChapters(env, settings);
  const r2 = route2(method, seg);
  const frameworks = async () => {
    const on = fwOn(settings);
    const { results } = await env.DB.prepare('SELECT framework, COUNT(*) AS n FROM standards WHERE active = 1 GROUP BY framework').all();
    const n = Object.fromEntries(results.map((r) => [r.framework, r.n]));
    return FW_KEYS.map((key) => ({ key, ...FRAMEWORKS[key], on: on.includes(key), n: n[key] || 0 })).sort((a, b) => (a.on === b.on ? on.indexOf(a.key) - on.indexOf(b.key) : a.on ? -1 : 1));
  };

  // One framework's chapters with their readiness, the ESR line across chapters, and the whole framework.
  if (r2 === 'GET /quality') {
    const fw = readFw(url.searchParams.get('framework'), settings);
    const S2 = STATS.replace(/\b(score|esr)\b(?= (=|IS|IN))/g, 's.$1');
    const [{ results: chapters }, { results: by }, all, { results: departments }, { results: deptList }, { results: fileCounts }, esr, fws] = await Promise.all([
      env.DB.prepare('SELECT * FROM std_chapters WHERE framework = ? ORDER BY sort, code').bind(fw).all(),
      env.DB.prepare(`SELECT chapter, ${STATS} FROM standards WHERE active = 1 AND framework = ? GROUP BY chapter`).bind(fw).all(),
      env.DB.prepare(`SELECT ${STATS} FROM standards WHERE active = 1 AND framework = ?`).bind(fw).first(),
      env.DB.prepare(
        `SELECT s.department_id, d.name_ar, d.name_en, ${S2} FROM standards s JOIN departments d ON d.id = s.department_id
          WHERE s.active = 1 AND s.framework = ? GROUP BY s.department_id ORDER BY d.name_ar`,
      ).bind(fw).all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
      // Files are filed under CBAHI chapters.
      fw === 'cbahi'
        ? env.DB.prepare(
            `SELECT chapter, COUNT(*) AS n FROM (SELECT chapter FROM files WHERE chapter IS NOT NULL ${portalDocsOn(settings) ? 'UNION ALL SELECT chapter FROM portal_docs WHERE chapter IS NOT NULL' : ''}) GROUP BY chapter`,
          ).all()
        : { results: [] },
      env.DB.prepare(`SELECT ${STATS} FROM standards WHERE active = 1 AND esr = 1 AND framework = ?`).bind(fw).first(),
      frameworks(),
    ]);
    const filesBy = Object.fromEntries(fileCounts.map((r) => [r.chapter, r.n]));
    const map = Object.fromEntries(by.map((r) => [r.chapter, r]));
    return json({
      framework: fw,
      frameworks: fws,
      has_esr: FRAMEWORKS[fw].esr,
      chapters: chapters.map((c) => ({ ...c, stats: withPct(map[c.code] || { n: 0 }), files: filesBy[c.code] || 0 })),
      esr: withPct(esr),
      total: withPct(all),
      departments: departments.map(withPct),
      dept_list: deptList,
      can_manage: manager,
      can_assess: manager || role === 'assessor',
      fms: fw === 'cbahi' ? fmsEvidence(settings) : null,
    });
  }

  // Which frameworks the hospital works with, in the order the tabs show them.
  if (r2 === 'PUT /quality/frameworks') {
    needManager();
    const body = await readJson(request);
    const on = (Array.isArray(body.on) ? body.on : []).map((x) => String(x)).filter((x, i, a) => FW_KEYS.includes(x) && a.indexOf(x) === i);
    if (!on.length) fail(400, 'std_bad_framework');
    await env.DB.batch([setSettingStmt(env, 'std_frameworks', on.join(',')), logStmt(env, user, 'update', 'settings', null, 'std_frameworks', { std_frameworks: [settings.std_frameworks, on.join(',')] })]);
    return json({ ok: true, frameworks: on });
  }

  // The chapter's files (policies, plans, records) from the documents system, for every quality user:
  // they are the chapter's evidence, so they are shown whatever department owns them. Read only here;
  // adding and changing stays with the people who manage documents.
  if (r2 === 'GET /quality/files') {
    const ch = str(url.searchParams.get('chapter') || '', 6).toUpperCase();
    if (!ch) fail(400, 'std_bad_chapter');
    const [{ results }, { results: types }, { results: portal }] = await Promise.all([
      env.DB.prepare(
        `SELECT f.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM files f LEFT JOIN departments d ON d.id = f.department_id
          WHERE f.chapter = ? ORDER BY f.doc_type, f.name LIMIT 1000`,
      ).bind(ch).all(),
      env.DB.prepare('SELECT key, name_ar, name_en FROM doc_types ORDER BY id').all(),
      // The portal's documents filed under this chapter, when the link reads them.
      portalDocsOn(settings) ? env.DB.prepare('SELECT * FROM portal_docs WHERE chapter = ? ORDER BY doc_type, name_ar LIMIT 1000').bind(ch).all() : { results: [] },
    ]);
    const today = todayIn(settings.timezone);
    const fromPortal = portal.map((p) => ({
      id: 'p' + p.id, portal: true, name: p.name_ar, name_en: p.name_en || '', file_number: p.file_number, doc_type: p.doc_type, type_ar: p.type_ar, type_en: p.type_en,
      issue_date: p.issue_date, expiry_date: p.expiry_date, status: p.status || 'none', has_pdf: !!p.has_pdf, dept_ar: p.department_ar, dept_en: p.department_en, pdf_url: portalDocUrl(p.id),
    }));
    return json({
      files: [...results.map((f) => ({ ...fileOut(f, today, settings), dept_ar: f.dept_ar, dept_en: f.dept_en, pdf_url: '/api/quality/files/' + f.id + '/pdf' })), ...fromPortal],
      doc_types: types,
      // Documents come from the Operations system while the link reads them: nothing is added here then.
      can_add: !portalDocsOn(settings) && (user.docs === 'admin' || user.docs === 'dept_admin'),
      locked: portalDocsOn(settings) && (user.docs === 'admin' || user.docs === 'dept_admin'),
    });
  }
  if (method === 'GET' && seg[0] === 'quality' && seg[1] === 'files' && /^\d+$/.test(seg[2] || '') && seg[3] === 'pdf' && seg.length === 4) {
    const f = await env.DB.prepare('SELECT pdf_key FROM files WHERE id = ? AND chapter IS NOT NULL').bind(Number(seg[2])).first();
    const obj = f && f.pdf_key ? await env.FILES.get(f.pdf_key) : null;
    if (!obj) fail(404, 'not_found');
    return new Response(obj.body, {
      headers: { 'content-type': 'application/pdf', 'content-length': String(obj.size), 'content-disposition': 'inline', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    });
  }

  // A chapter: change its names or JCI mapping (managers), or add a new one. ?framework= picks the framework.
  if (seg[0] === 'std-chapters') {
    needManager();
    const fw = readFw(url.searchParams.get('framework'), settings);
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);
    const read = () => {
      const name_ar = str(body.name_ar, 120);
      const name_en = str(body.name_en, 120);
      if (!name_ar || !name_en) fail(400, 'name_required');
      if (!ARABIC_RE.test(name_ar)) fail(400, 'ar_needs_arabic');
      if (ARABIC_RE.test(name_en)) fail(400, 'name_en_arabic');
      return { name_ar, name_en, jci: str(body.jci, 60) || null, active: body.active === false ? 0 : 1 };
    };
    if (r2 === 'POST /std-chapters') {
      const code = str(body.code, 6).toUpperCase();
      if (!CODE_RE.test(code)) fail(400, 'std_bad_code');
      const d = read();
      if (await env.DB.prepare('SELECT 1 FROM std_chapters WHERE framework = ? AND code = ?').bind(fw, code).first()) fail(409, 'std_chapter_taken');
      const sort = (await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM std_chapters WHERE framework = ?').bind(fw).first()).n;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO std_chapters (framework, code, name_ar, name_en, jci, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(fw, code, d.name_ar, d.name_en, d.jci, sort, d.active),
        logStmt(env, user, 'create', 'std_chapter', null, fw + ':' + code + ' ' + d.name_ar),
      ]);
      return json({ ok: true, code });
    }
    if (method === 'PUT' && seg.length === 2) {
      const code = str(decodeURIComponent(seg[1]), 6).toUpperCase();
      const old = await env.DB.prepare('SELECT * FROM std_chapters WHERE framework = ? AND code = ?').bind(fw, code).first();
      if (!old) fail(404, 'not_found');
      const d = read();
      await env.DB.batch([
        env.DB.prepare('UPDATE std_chapters SET name_ar = ?, name_en = ?, jci = ?, active = ? WHERE framework = ? AND code = ?').bind(d.name_ar, d.name_en, d.jci, d.active, fw, code),
        logStmt(env, user, 'update', 'std_chapter', null, fw + ':' + code + ' ' + d.name_ar, { name_ar: [old.name_ar, d.name_ar], name_en: [old.name_en, d.name_en], jci: [old.jci, d.jci], active: [old.active, d.active] }),
      ]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  if (seg[0] !== 'standards') return null;
  const chapterSet = async (fw) => new Set((await env.DB.prepare('SELECT code FROM std_chapters WHERE framework = ?').bind(fw).all()).results.map((c) => c.code));

  // The standards of one chapter (or ESR = every ESR standard), with their latest score and their elements.
  if (r2 === 'GET /standards') {
    const fw = readFw(url.searchParams.get('framework'), settings);
    const ch = str(url.searchParams.get('chapter') || '', 6).toUpperCase();
    const where = ['s.active = 1', 's.framework = ?'];
    const binds = [fw];
    if (ch === 'ESR') where.push('s.esr = 1');
    else if (ch) {
      where.push('s.chapter = ?');
      binds.push(ch);
    }
    const [{ results }, { results: els }, { results: acts }] = await Promise.all([
      env.DB.prepare(
        `SELECT s.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM standards s LEFT JOIN departments d ON d.id = s.department_id
          WHERE ${where.join(' AND ')} ORDER BY s.chapter, s.id LIMIT 3000`,
      ).bind(...binds).all(),
      env.DB.prepare(`SELECT e.* FROM std_elements e JOIN standards s ON s.id = e.standard_id WHERE ${where.join(' AND ')} ORDER BY e.standard_id, e.sort, e.id LIMIT 20000`).bind(...binds).all(),
      env.DB.prepare(`SELECT a.id, a.element_id, a.kind, a.score, a.note, a.assessed_at, a.assessed_by FROM std_activities a JOIN standards s ON s.id = a.standard_id WHERE ${where.join(' AND ')} ORDER BY a.element_id, a.sort, a.id LIMIT 50000`).bind(...binds).all(),
    ]);
    const byEl = {};
    for (const a of acts) (byEl[a.element_id] = byEl[a.element_id] || []).push(a);
    const byStd = {};
    for (const e of els) (byStd[e.standard_id] = byStd[e.standard_id] || []).push({ ...e, activities: byEl[e.id] || [] });
    return json({ framework: fw, standards: results.map((s) => ({ ...s, elements: byStd[s.id] || [], can_score: canScore(s) })), can_manage: manager });
  }

  // An import pack (built from the hospital's own copy of the manual), sent in parts of up to 40 standards:
  // the chapters, the standards and their elements are added, or updated by code. Scores already given stay.
  if (r2 === 'POST /standards/pack') {
    needManager();
    const body = await readJson(request);
    const fw = readFw(body.framework, settings);
    if (!body.framework) fail(400, 'std_bad_framework');
    const chapters = Array.isArray(body.chapters) ? body.chapters.slice(0, 80) : [];
    const list = Array.isArray(body.standards) ? body.standards.slice(0, 40) : [];
    if (!chapters.length && !list.length) fail(400, 'std_nothing');
    const now = nowIso();
    const chStmts = [];
    for (const c of chapters) {
      const code = str(c && c.code, 6).toUpperCase();
      const name_en = str(c && c.name_en, 120);
      const name_ar = str(c && c.name_ar, 120);
      if (!CODE_RE.test(code) || !name_en) fail(400, 'std_bad_chapter');
      chStmts.push(
        env.DB.prepare(
          `INSERT INTO std_chapters (framework, code, name_ar, name_en, jci, sort, active) VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(framework, code) DO UPDATE SET name_en = excluded.name_en, name_ar = CASE WHEN std_chapters.name_ar = '' THEN excluded.name_ar ELSE std_chapters.name_ar END, sort = excluded.sort`,
        ).bind(fw, code, ARABIC_RE.test(name_ar) ? name_ar : '', name_en, str(c.jci, 60) || null, Number.isInteger(c.sort) ? c.sort : 0),
      );
    }
    if (chStmts.length) await env.DB.batch(chStmts);
    const known = await chapterSet(fw);
    const errors = [];
    const ok = [];
    list.forEach((row, i) => {
      try {
        const d = readStandard({ ...(row || {}), jci: fw === 'cbahi' ? row && row.jci : null }, known, true);
        const elements = (Array.isArray(row.elements) ? row.elements.slice(0, 60) : [])
          .map((e, k) => ({ num: str(e && String(e.num ?? ''), 10), text: str(e && e.text, 4000), doc: e && e.doc ? 1 : 0, is_new: e && e.is_new ? 1 : 0, sort: k + 1 }))
          .filter((e) => e.num && e.text);
        ok.push({ ...d, elements });
      } catch (e) {
        errors.push({ row: i + 1, code: str(row && row.code, 30), error: e.code || 'bad_row' });
      }
    });
    if (ok.length) {
      await env.DB.batch(
        ok.map((d) =>
          env.DB.prepare(
            `INSERT INTO standards (framework, chapter, code, title_ar, title_en, esr, jci, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(framework, code) DO UPDATE SET chapter = excluded.chapter, title_en = excluded.title_en,
               title_ar = CASE WHEN excluded.title_ar <> '' THEN excluded.title_ar ELSE standards.title_ar END,
               esr = excluded.esr, jci = COALESCE(excluded.jci, standards.jci), active = 1, updated_at = excluded.updated_at`,
          ).bind(fw, d.chapter, d.code, d.title_ar, d.title_en, d.esr, d.jci, now, now),
        ),
      );
      const codes = ok.map((d) => d.code);
      const { results: ids } = await env.DB.prepare(`SELECT id, code FROM standards WHERE framework = ? AND code IN (${codes.map(() => '?').join(',')})`).bind(fw, ...codes).all();
      const idOf = Object.fromEntries(ids.map((r) => [r.code, r.id]));
      const stmts = [];
      for (const d of ok) {
        const sid = idOf[d.code];
        for (const e of d.elements)
          stmts.push(
            env.DB.prepare(
              `INSERT INTO std_elements (standard_id, num, text, doc, is_new, sort) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(standard_id, num) DO UPDATE SET text = excluded.text, doc = excluded.doc, is_new = excluded.is_new, sort = excluded.sort`,
            ).bind(sid, e.num, e.text, e.doc, e.is_new, e.sort),
          );
        // An element the new edition dropped goes, unless it was already scored.
        if (d.elements.length)
          stmts.push(env.DB.prepare(`DELETE FROM std_elements WHERE standard_id = ? AND score IS NULL AND id NOT IN (SELECT element_id FROM std_activities WHERE standard_id = ?) AND num NOT IN (${d.elements.map(() => '?').join(',')})`).bind(sid, sid, ...d.elements.map((e) => e.num)));
      }
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    }
    // The first part turns the framework on, so its tab shows.
    const on = fwOn(settings);
    const after = [];
    if (!on.includes(fw)) after.push(setSettingStmt(env, 'std_frameworks', [...on, fw].join(',')));
    if (body.first || body.last) after.push(logStmt(env, user, 'import', 'standard', null, fw + (body.edition ? ' ' + str(body.edition, 30) : ''), { saved: ok.length, errors: errors.length }));
    if (after.length) await env.DB.batch(after);
    return json({ ok: true, saved: ok.length, errors });
  }

  // Many standards at once, pasted from Excel: added, or updated when the code is already there.
  if (r2 === 'POST /standards/import') {
    needManager();
    const body = await readJson(request);
    const fw = readFw(body.framework, settings);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
    if (!rows.length) fail(400, 'std_nothing');
    const chapters = await chapterSet(fw);
    const now = nowIso();
    const ok = [];
    const errors = [];
    rows.forEach((row, i) => {
      try {
        ok.push(readStandard(row || {}, chapters));
      } catch (e) {
        errors.push({ row: i + 1, code: str(row && row.code, 30), error: e.code || 'bad_row' });
      }
    });
    // Upsert keeps the score of a standard already assessed.
    const stmts = ok.map((s) =>
      env.DB.prepare(
        `INSERT INTO standards (framework, chapter, code, title_ar, title_en, esr, jci, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(framework, code) DO UPDATE SET chapter = excluded.chapter, title_ar = excluded.title_ar, title_en = excluded.title_en, esr = excluded.esr, jci = excluded.jci, active = 1, updated_at = excluded.updated_at`,
      ).bind(fw, s.chapter, s.code, s.title_ar, s.title_en, s.esr, s.jci, now, now),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await logStmt(env, user, 'import', 'standard', null, null, { saved: ok.length, errors: errors.length }).run();
    return json({ ok: true, saved: ok.length, errors });
  }

  if (r2 === 'POST /standards') {
    needManager();
    const body = await readJson(request);
    const fw = readFw(body.framework, settings);
    const d = readStandard(body, await chapterSet(fw));
    if (await env.DB.prepare('SELECT 1 FROM standards WHERE framework = ? AND code = ?').bind(fw, d.code).first()) fail(409, 'std_code_taken');
    const now = nowIso();
    const res = await env.DB.prepare('INSERT INTO standards (framework, chapter, code, title_ar, title_en, esr, jci, department_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(fw, d.chapter, d.code, d.title_ar, d.title_en, d.esr, d.jci, d.department_id, now, now)
      .run();
    await logStmt(env, user, 'create', 'standard', res.meta.last_row_id, d.code).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  const id = /^\d+$/.test(seg[1] || '') ? Number(seg[1]) : 0;
  const std = id ? await env.DB.prepare('SELECT * FROM standards WHERE id = ?').bind(id).first() : null;
  if (!std) fail(404, 'not_found');

  // How the standard's score moved over time.
  if (method === 'GET' && seg[2] === 'history' && seg.length === 3) {
    const { results } = await env.DB.prepare('SELECT score, note, evidence, user_name, at FROM std_assessments WHERE standard_id = ? AND element_id IS NULL ORDER BY at DESC, id DESC LIMIT 100').bind(id).all();
    return json({ standard: std, history: results });
  }

  // The self-assessment: a score, what is missing, and where the evidence is (a document number, a link...).
  // A standard with elements is scored element by element; its own score is worked out from them.
  if (method === 'PUT' && seg[2] === 'score' && seg.length === 3) {
    if (!canScore(std)) fail(403, 'forbidden');
    const body = await readJson(request);
    const { results: els } = await env.DB.prepare('SELECT * FROM std_elements WHERE standard_id = ? ORDER BY sort, id').bind(id).all();
    const now = nowIso();
    const stmts = [];
    let score;
    if (els.length) {
      const given = Object.fromEntries((Array.isArray(body.elements) ? body.elements : []).map((e) => [Number(e && e.id), e || {}]));
      const scores = [];
      for (const e of els) {
        const g = given[e.id];
        if (!g) {
          scores.push(e.score);
          continue;
        }
        const sc = STD_SCORES.includes(g.score) ? g.score : null;
        if (!sc) fail(400, 'std_bad_score');
        const enote = str(g.note, 1000) || null;
        scores.push(sc);
        if (sc === e.score && enote === e.note) continue;
        stmts.push(
          env.DB.prepare('UPDATE std_elements SET score = ?, note = ?, assessed_at = ?, assessed_by = ? WHERE id = ?').bind(sc, enote, now, user.name, e.id),
          env.DB.prepare('INSERT INTO std_assessments (standard_id, element_id, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, e.id, sc, enote, user.id, user.name, now),
        );
      }
      score = rollup(scores, FRAMEWORKS[std.framework]?.esr && std.esr);
      if (!score) fail(400, 'std_elements_open');
    } else {
      score = STD_SCORES.includes(body.score) ? body.score : null;
      if (!score) fail(400, 'std_bad_score');
    }
    const note = str(body.note, 2000) || null;
    const evidence = str(body.evidence, 1000) || null;
    // A gap needs a word on what is missing, so the action plan has something to start from.
    if ((score === 'partial' || score === 'not_met') && !note) fail(400, 'std_gap_note');
    await env.DB.batch([
      ...stmts,
      env.DB.prepare('UPDATE standards SET score = ?, note = ?, evidence = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?').bind(score, note, evidence, now, user.name, now, id),
      env.DB.prepare('INSERT INTO std_assessments (standard_id, score, note, evidence, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, score, note, evidence, user.id, user.name, now),
      logStmt(env, user, 'assess', 'standard', id, std.code, { score: [std.score, score] }),
    ]);
    return json({ ok: true, score });
  }

  // The chapter scoring page: one element's activities, saved as they are scored. Each activity has its own
  // score and comment; an activity left out is removed, one with no score is still open. The element's score
  // comes from its activities, the standard's from its elements once they are all scored.
  if (method === 'PUT' && seg[2] === 'elements' && /^\d+$/.test(seg[3] || '') && seg.length === 4) {
    if (!canScore(std)) fail(403, 'forbidden');
    const eid = Number(seg[3]);
    const el = await env.DB.prepare('SELECT * FROM std_elements WHERE id = ? AND standard_id = ?').bind(eid, id).first();
    if (!el) fail(404, 'not_found');
    const body = await readJson(request);
    const list = (Array.isArray(body.activities) ? body.activities : []).slice(0, 10);
    if (!list.length) fail(400, 'std_no_activity');
    const want = list.map((a, k) => {
      const kind = STD_ACTIVITIES.includes(a && a.kind) ? a.kind : fail(400, 'std_bad_activity');
      const score = a.score === null || a.score === undefined || a.score === '' ? null : STD_SCORES.includes(a.score) ? a.score : fail(400, 'std_bad_score');
      return { id: Number.isInteger(a.id) ? a.id : null, kind, score, note: str(a.note, 1000) || null, sort: k + 1 };
    });
    const { results: had } = await env.DB.prepare('SELECT * FROM std_activities WHERE element_id = ?').bind(eid).all();
    const old = Object.fromEntries(had.map((a) => [a.id, a]));
    if (want.some((a) => a.id && !old[a.id])) fail(404, 'not_found');
    const now = nowIso();
    const stmts = [];
    const keep = new Set(want.filter((a) => a.id).map((a) => a.id));
    for (const a of had) if (!keep.has(a.id)) stmts.push(env.DB.prepare('DELETE FROM std_activities WHERE id = ?').bind(a.id));
    const history = (aid, a) => (a.score ? [env.DB.prepare('INSERT INTO std_assessments (standard_id, element_id, activity_id, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, eid, aid, a.score, a.note, user.id, user.name, now)] : []);
    // New activities first, so their ids can go back to the page.
    const added = [];
    for (const a of want.filter((x) => !x.id)) {
      const res = await env.DB.prepare('INSERT INTO std_activities (standard_id, element_id, kind, score, note, assessed_at, assessed_by, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, eid, a.kind, a.score, a.note, a.score ? now : null, a.score ? user.name : null, a.sort)
        .run();
      a.id = res.meta.last_row_id;
      added.push(a);
      stmts.push(...history(a.id, a));
    }
    for (const a of want.filter((x) => !added.includes(x))) {
      const o = old[a.id];
      const changed = o.score !== a.score || (o.note || null) !== a.note;
      if (!changed && o.kind === a.kind && o.sort === a.sort) continue;
      stmts.push(
        env.DB.prepare('UPDATE std_activities SET kind = ?, score = ?, note = ?, sort = ?, assessed_at = ?, assessed_by = ? WHERE id = ?').bind(
          a.kind, a.score, a.note, a.sort, changed ? (a.score ? now : null) : o.assessed_at, changed ? (a.score ? user.name : null) : o.assessed_by, a.id,
        ),
      );
      if (changed) stmts.push(...history(a.id, a));
    }
    // The element: open while an activity is open; its note gathers the activities' comments.
    const escore = rollup(want.map((a) => a.score), false);
    const enote = want.map((a) => a.note).filter(Boolean).join(' · ').slice(0, 1000) || null;
    stmts.push(env.DB.prepare('UPDATE std_elements SET score = ?, note = ?, assessed_at = ?, assessed_by = ? WHERE id = ?').bind(escore, enote, escore ? now : null, escore ? user.name : null, eid));
    const { results: others } = await env.DB.prepare('SELECT id, score FROM std_elements WHERE standard_id = ?').bind(id).all();
    const score = rollup(others.map((e) => (e.id === eid ? escore : e.score)), FRAMEWORKS[std.framework]?.esr && std.esr);
    if (score !== std.score) {
      stmts.push(
        env.DB.prepare('UPDATE standards SET score = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?').bind(score, score ? now : null, score ? user.name : null, now, id),
        logStmt(env, user, 'assess', 'standard', id, std.code, { score: [std.score, score] }),
      );
      if (score) stmts.push(env.DB.prepare('INSERT INTO std_assessments (standard_id, score, note, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, score, std.note, user.id, user.name, now));
    }
    await env.DB.batch(stmts);
    return json({ ok: true, element: { id: eid, score: escore, note: enote }, activities: want.map((a) => ({ id: a.id, kind: a.kind, score: a.score, note: a.note })), score });
  }

  if (method === 'PUT' && seg.length === 2) {
    needManager();
    const d = readStandard(await readJson(request), await chapterSet(std.framework), !std.title_ar);
    if (d.code !== std.code && (await env.DB.prepare('SELECT 1 FROM standards WHERE framework = ? AND code = ? AND id <> ?').bind(std.framework, d.code, id).first())) fail(409, 'std_code_taken');
    await env.DB.batch([
      env.DB.prepare('UPDATE standards SET chapter = ?, code = ?, title_ar = ?, title_en = ?, esr = ?, jci = ?, department_id = ?, updated_at = ? WHERE id = ?').bind(d.chapter, d.code, d.title_ar, d.title_en, d.esr, d.jci, d.department_id, nowIso(), id),
      logStmt(env, user, 'update', 'standard', id, d.code, { code: [std.code, d.code], esr: [std.esr, d.esr], jci: [std.jci, d.jci], department_id: [std.department_id, d.department_id] }),
    ]);
    return json({ ok: true });
  }

  // Deleting a standard that was assessed would lose its history: it is retired instead.
  if (method === 'DELETE' && seg.length === 2) {
    needManager();
    const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM std_assessments WHERE standard_id = ?').bind(id).first();
    await env.DB.batch([
      ...(used.n
        ? [env.DB.prepare('UPDATE standards SET active = 0, updated_at = ? WHERE id = ?').bind(nowIso(), id)]
        : [env.DB.prepare('DELETE FROM std_activities WHERE standard_id = ?').bind(id), env.DB.prepare('DELETE FROM std_elements WHERE standard_id = ?').bind(id), env.DB.prepare('DELETE FROM standards WHERE id = ?').bind(id)]),
      logStmt(env, user, used.n ? 'retire' : 'delete', 'standard', id, std.code),
    ]);
    return json({ ok: true, retired: !!used.n });
  }
  fail(405, 'method_not_allowed');
}

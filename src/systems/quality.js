// Quality & Accreditation: the CBAHI chapters, their standards, the self-assessment and the readiness score.
// Every standard can carry the JCI standards it matches, so one self-assessment serves both surveys.
import { readJson } from '../lib/auth.js';
import { isAdmin } from '../lib/config.js';
import { getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { ARABIC_RE, fail, json, nowIso, str } from '../lib/util.js';
import { route2 } from './assets.js';

// met = fully met, partial = partially met, not_met, na = not applicable to this hospital.
export const STD_SCORES = ['met', 'partial', 'not_met', 'na'];

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

const CODE_RE = /^[A-Z]{2,6}$/;
const STD_CODE_RE = /^[A-Za-z]{2,6}[A-Za-z0-9.\-]{0,20}$/;
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
export const chapterOf = (code) => (/^([A-Za-z]{2,6})/.exec(code) || [])[1]?.toUpperCase() || '';

async function seedChapters(env, settings) {
  if (settings.std_chapters_seeded === '1') return;
  await env.DB.batch([
    ...STARTER_CHAPTERS.map(([code, ar, en, jci, sort]) => env.DB.prepare('INSERT OR IGNORE INTO std_chapters (code, name_ar, name_en, jci, sort) VALUES (?, ?, ?, ?, ?)').bind(code, ar, en, jci, sort)),
    setSettingStmt(env, 'std_chapters_seeded', '1'),
  ]);
}

// The numbers on the portal's home card.
export async function qualityHome(env) {
  const r = await env.DB.prepare(`SELECT ${STATS} FROM standards WHERE active = 1`).first();
  return { pct: readiness(r), esr_gap: r.esr_gap || 0, open: r.open || 0, n: r.n || 0 };
}

function readStandard(body, chapters) {
  const code = str(body.code, 30).replace(/\s+/g, '');
  if (!STD_CODE_RE.test(code)) fail(400, 'std_bad_code');
  const chapter = (str(body.chapter, 6) || chapterOf(code)).toUpperCase();
  if (!chapters.has(chapter)) fail(400, 'std_bad_chapter');
  const title_ar = str(body.title_ar, 1000);
  const title_en = str(body.title_en, 1000);
  if (!title_ar || !title_en) fail(400, 'name_required');
  if (!ARABIC_RE.test(title_ar)) fail(400, 'ar_needs_arabic');
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

  // The chapters with their readiness, the ESR line across chapters, and the whole hospital.
  if (r2 === 'GET /quality') {
    const [{ results: chapters }, { results: by }, all, { results: departments }, { results: deptList }] = await Promise.all([
      env.DB.prepare('SELECT * FROM std_chapters ORDER BY sort, code').all(),
      env.DB.prepare(`SELECT chapter, ${STATS} FROM standards WHERE active = 1 GROUP BY chapter`).all(),
      env.DB.prepare(`SELECT ${STATS} FROM standards WHERE active = 1`).first(),
      env.DB.prepare(
        `SELECT s.department_id, d.name_ar, d.name_en, ${STATS.replace(/\b(score|esr)\b(?= (=|IS|IN))/g, 's.$1')} FROM standards s JOIN departments d ON d.id = s.department_id
          WHERE s.active = 1 GROUP BY s.department_id ORDER BY d.name_ar`,
      ).all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments ORDER BY name_ar').all(),
    ]);
    const map = Object.fromEntries(by.map((r) => [r.chapter, r]));
    const esr = await env.DB.prepare(`SELECT ${STATS} FROM standards WHERE active = 1 AND esr = 1`).first();
    return json({
      chapters: chapters.map((c) => ({ ...c, stats: withPct(map[c.code] || { n: 0 }) })),
      esr: withPct(esr),
      total: withPct(all),
      departments: departments.map(withPct),
      dept_list: deptList,
      can_manage: manager,
      can_assess: manager || role === 'assessor',
    });
  }

  // A chapter: change its names or JCI mapping (managers), or add a new one.
  if (seg[0] === 'std-chapters') {
    needManager();
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
      if (await env.DB.prepare('SELECT 1 FROM std_chapters WHERE code = ?').bind(code).first()) fail(409, 'std_chapter_taken');
      const sort = (await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM std_chapters').first()).n;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO std_chapters (code, name_ar, name_en, jci, sort, active) VALUES (?, ?, ?, ?, ?, ?)').bind(code, d.name_ar, d.name_en, d.jci, sort, d.active),
        logStmt(env, user, 'create', 'std_chapter', null, code + ' ' + d.name_ar),
      ]);
      return json({ ok: true, code });
    }
    if (method === 'PUT' && seg.length === 2) {
      const code = str(seg[1], 6).toUpperCase();
      const old = await env.DB.prepare('SELECT * FROM std_chapters WHERE code = ?').bind(code).first();
      if (!old) fail(404, 'not_found');
      const d = read();
      await env.DB.batch([
        env.DB.prepare('UPDATE std_chapters SET name_ar = ?, name_en = ?, jci = ?, active = ? WHERE code = ?').bind(d.name_ar, d.name_en, d.jci, d.active, code),
        logStmt(env, user, 'update', 'std_chapter', null, code + ' ' + d.name_ar, { name_ar: [old.name_ar, d.name_ar], name_en: [old.name_en, d.name_en], jci: [old.jci, d.jci], active: [old.active, d.active] }),
      ]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  if (seg[0] !== 'standards') return null;
  const chapterSet = async () => new Set((await env.DB.prepare('SELECT code FROM std_chapters').all()).results.map((c) => c.code));

  // The standards of one chapter (or ESR = every ESR standard), with their latest score.
  if (r2 === 'GET /standards') {
    const ch = str(url.searchParams.get('chapter') || '', 6).toUpperCase();
    const where = ['s.active = 1'];
    const binds = [];
    if (ch === 'ESR') where.push('s.esr = 1');
    else if (ch) {
      where.push('s.chapter = ?');
      binds.push(ch);
    }
    const { results } = await env.DB.prepare(
      `SELECT s.*, d.name_ar AS dept_ar, d.name_en AS dept_en FROM standards s LEFT JOIN departments d ON d.id = s.department_id
        WHERE ${where.join(' AND ')} ORDER BY s.chapter, s.code LIMIT 3000`,
    ).bind(...binds).all();
    return json({ standards: results.map((s) => ({ ...s, can_score: canScore(s) })), can_manage: manager });
  }

  // Many standards at once, pasted from Excel: added, or updated when the code is already there.
  if (r2 === 'POST /standards/import') {
    needManager();
    const body = await readJson(request);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
    if (!rows.length) fail(400, 'std_nothing');
    const chapters = await chapterSet();
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
        `INSERT INTO standards (chapter, code, title_ar, title_en, esr, jci, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(code) DO UPDATE SET chapter = excluded.chapter, title_ar = excluded.title_ar, title_en = excluded.title_en, esr = excluded.esr, jci = excluded.jci, active = 1, updated_at = excluded.updated_at`,
      ).bind(s.chapter, s.code, s.title_ar, s.title_en, s.esr, s.jci, now, now),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await logStmt(env, user, 'import', 'standard', null, null, { saved: ok.length, errors: errors.length }).run();
    return json({ ok: true, saved: ok.length, errors });
  }

  if (r2 === 'POST /standards') {
    needManager();
    const d = readStandard(await readJson(request), await chapterSet());
    if (await env.DB.prepare('SELECT 1 FROM standards WHERE code = ?').bind(d.code).first()) fail(409, 'std_code_taken');
    const now = nowIso();
    const res = await env.DB.prepare('INSERT INTO standards (chapter, code, title_ar, title_en, esr, jci, department_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(d.chapter, d.code, d.title_ar, d.title_en, d.esr, d.jci, d.department_id, now, now)
      .run();
    await logStmt(env, user, 'create', 'standard', res.meta.last_row_id, d.code).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  const id = /^\d+$/.test(seg[1] || '') ? Number(seg[1]) : 0;
  const std = id ? await env.DB.prepare('SELECT * FROM standards WHERE id = ?').bind(id).first() : null;
  if (!std) fail(404, 'not_found');

  // How the standard's score moved over time.
  if (method === 'GET' && seg[2] === 'history' && seg.length === 3) {
    const { results } = await env.DB.prepare('SELECT score, note, evidence, user_name, at FROM std_assessments WHERE standard_id = ? ORDER BY at DESC, id DESC LIMIT 100').bind(id).all();
    return json({ standard: std, history: results });
  }

  // The self-assessment: a score, what is missing, and where the evidence is (a document number, a link...).
  if (method === 'PUT' && seg[2] === 'score' && seg.length === 3) {
    if (!canScore(std)) fail(403, 'forbidden');
    const body = await readJson(request);
    const score = STD_SCORES.includes(body.score) ? body.score : null;
    if (!score) fail(400, 'std_bad_score');
    const note = str(body.note, 2000) || null;
    const evidence = str(body.evidence, 1000) || null;
    // A gap needs a word on what is missing, so the action plan has something to start from.
    if ((score === 'partial' || score === 'not_met') && !note) fail(400, 'std_gap_note');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('UPDATE standards SET score = ?, note = ?, evidence = ?, assessed_at = ?, assessed_by = ?, updated_at = ? WHERE id = ?').bind(score, note, evidence, now, user.name, now, id),
      env.DB.prepare('INSERT INTO std_assessments (standard_id, score, note, evidence, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, score, note, evidence, user.id, user.name, now),
      logStmt(env, user, 'assess', 'standard', id, std.code, { score: [std.score, score] }),
    ]);
    return json({ ok: true });
  }

  if (method === 'PUT' && seg.length === 2) {
    needManager();
    const d = readStandard(await readJson(request), await chapterSet());
    if (d.code !== std.code && (await env.DB.prepare('SELECT 1 FROM standards WHERE code = ? AND id <> ?').bind(d.code, id).first())) fail(409, 'std_code_taken');
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
      used.n ? env.DB.prepare('UPDATE standards SET active = 0, updated_at = ? WHERE id = ?').bind(nowIso(), id) : env.DB.prepare('DELETE FROM standards WHERE id = ?').bind(id),
      logStmt(env, user, used.n ? 'retire' : 'delete', 'standard', id, std.code),
    ]);
    return json({ ok: true, retired: !!used.n });
  }
  fail(405, 'method_not_allowed');
}

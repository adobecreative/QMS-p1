// Document Control: file status, the sample data and the daily expiry reminders.
import { MAX_PDF_BYTES, isAdmin } from '../lib/config.js';
import { getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { bothLangs, buildDigest, mailReady, sendMail } from '../lib/mail.js';
import { MAX_TEXT_CHARS, checkLang, diffDays, fail, nowIso, optDate, str, todayIn } from '../lib/util.js';

/* ------------------------------ file status ------------------------------ */

// review  = white (set by hand)      none   = permanent file, no tracking
// expired = red                       near   = yellow          valid = green
export function statusOf(f, today, defaultNear) {
  if (f.under_review) return { status: 'review', days: f.expiry_date ? diffDays(f.expiry_date, today) : null };
  if (!f.expiry_date) return { status: 'none', days: null };
  const days = diffDays(f.expiry_date, today);
  if (days < 0) return { status: 'expired', days };
  const near = f.near_days ?? defaultNear;
  return { status: days <= near ? 'near' : 'valid', days };
}

export function fileOut(f, today, settings) {
  const st = statusOf(f, today, settings.near_days);
  return {
    id: f.id,
    department_id: f.department_id,
    name: f.name,
    name_en: f.name_en || '',
    file_number: f.file_number,
    doc_type: f.doc_type,
    chapter: f.chapter || null,
    issue_date: f.issue_date,
    expiry_date: f.expiry_date,
    near_days: f.near_days,
    under_review: !!f.under_review,
    notify_date: f.notify_date,
    has_pdf: !!f.pdf_key,
    pdf_name: f.pdf_name,
    status: st.status,
    days_left: st.days,
    updated_at: f.updated_at,
  };
}

export async function checkChapter(env, chapter) {
  if (chapter && !(await env.DB.prepare("SELECT 1 FROM std_chapters WHERE framework = 'cbahi' AND code = ?").bind(chapter).first())) fail(400, 'std_bad_chapter');
}

export function readFileFields(form) {
  // The English name is required and has no Arabic letters. The Arabic one is the file's main name and falls back to it.
  const name_en = str(form.get('name_en'), 200);
  if (!name_en) fail(400, 'name_en_required');
  checkLang((k) => form.get(k), ['name'], ['name_en', 'file_number']);
  const name = str(form.get('name'), 200);
  if (!name) fail(400, 'name_required');
  const file_number = str(form.get('file_number'), 60);
  if (!file_number) fail(400, 'number_required');
  const doc_type = str(form.get('doc_type'), 20);
  if (!doc_type) fail(400, 'invalid_type');
  const department_id = Number(form.get('department_id'));
  if (!Number.isInteger(department_id) || department_id < 1) fail(400, 'department_required');
  const issue_date = optDate(form.get('issue_date'));
  const expiry_date = optDate(form.get('expiry_date'));
  if (issue_date && expiry_date && expiry_date < issue_date) fail(400, 'expiry_before_issue');
  const nearRaw = str(form.get('near_days'), 5);
  let near_days = nearRaw === '' || !expiry_date ? null : Number(nearRaw);
  if (near_days !== null && (!Number.isInteger(near_days) || near_days < 0 || near_days > 3650)) fail(400, 'invalid_near_days');
  const notify_date = optDate(form.get('notify_date'));
  const under_review = form.get('under_review') === '1' ? 1 : 0;
  // The CBAHI chapter (checked against std_chapters by the caller). Empty = no chapter.
  const chapter = str(form.get('chapter'), 6).toUpperCase() || null;
  return { name, name_en, file_number, doc_type, department_id, issue_date, expiry_date, near_days, notify_date, under_review, chapter };
}

// Text the browser extracted from the PDF it is uploading. Missing text is fine: it is filled in later.
export function readText(src) {
  if (!src || typeof src.body !== 'string' || typeof src.compact !== 'string') return null;
  return { body: src.body.slice(0, MAX_TEXT_CHARS), compact: src.compact.slice(0, MAX_TEXT_CHARS) };
}
export const textStmt = (env, fileId, key, text) =>
  env.DB.prepare(
    `INSERT INTO file_texts (file_id, pdf_key, body, compact, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET pdf_key = excluded.pdf_key, body = excluded.body, compact = excluded.compact, updated_at = excluded.updated_at`,
  ).bind(fileId, key, text.body, text.compact, nowIso());

export async function readPdf(form) {
  const f = form.get('pdf');
  if (!f || typeof f === 'string' || !f.size) return null;
  if (f.size > MAX_PDF_BYTES) fail(413, 'pdf_too_large');
  const bytes = await f.arrayBuffer();
  const head = String.fromCharCode(...new Uint8Array(bytes.slice(0, 5)));
  if (head !== '%PDF-') fail(400, 'not_pdf');
  return { bytes, name: str(f.name, 200) || 'file.pdf', size: f.size };
}

/* ------------------------------- demo data ------------------------------- */

// Sample data for showing the system: every colour of status, spread over three departments.
// Dates are relative to today, so the colours stay right whenever the data is added.
export const DEMO_DEPARTMENTS = [
  ['السلامة', 'Safety'],
  ['الصيانة', 'Maintenance'],
  ['الأمن', 'Security'],
];
// [department index, name, number, type, issued (days from today), expires (days from today), extra]
export const DEMO_FILES = [
  [0, 'خطة الإخلاء والطوارئ', 'Evacuation and emergency plan', 'FM-SAF-001', 'program', -260, 105],
  [0, 'فحص أنظمة الإطفاء', 'Fire system inspection', 'FM-SAF-007', 'procedure', -385, -20],
  [0, 'سياسة تصاريح العمل', 'Work permit policy', 'FM-SAF-011', 'policy', -340, 25, { under_review: 1 }],
  [0, 'سياسة السلامة من الحريق', 'Fire safety policy', 'FM-SAF-021', 'policy', -213, 152],
  [1, 'عقد صيانة المصاعد', 'Lift maintenance contract', 'FM-MNT-014', 'program', -345, 20],
  [1, 'إجراء الصيانة الوقائية للتكييف', 'HVAC preventive maintenance procedure', 'FM-MNT-003', 'procedure', -65, 300],
  [1, 'دليل الهيكل التنظيمي', 'Organisation structure guide', 'FM-MNT-100', 'policy', -1300, null],
  [2, 'إجراء التحكم في الدخول', 'Access control procedure', 'FM-SEC-002', 'procedure', -356, 9],
  [2, 'سياسة كاميرات المراقبة', 'CCTV policy', 'FM-SEC-005', 'policy', -368, -3],
];
export const DEMO_PDF_PATH = '/demo-sample.pdf';

export function demoIds(settings) {
  try {
    const d = JSON.parse(settings.demo_ids || 'null');
    return d && Array.isArray(d.files) && Array.isArray(d.departments) ? d : null;
  } catch {
    return null;
  }
}

export function plusDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

export async function addDemo(env, user, origin) {
  const settings = await getSettings(env);
  if (demoIds(settings)) fail(409, 'demo_exists');
  const { results: types } = await env.DB.prepare('SELECT key FROM doc_types ORDER BY id').all();
  if (!types.length) fail(409, 'demo_no_types');
  const typeKeys = new Set(types.map((t) => t.key));
  const pdfRes = await env.ASSETS.fetch(new Request(origin + DEMO_PDF_PATH));
  if (!pdfRes.ok) fail(500, 'server_error');
  const pdf = await pdfRes.arrayBuffer();
  const today = todayIn(settings.timezone);
  const now = nowIso();

  const ids = { departments: [], files: [] };
  for (const [ar, en] of DEMO_DEPARTMENTS) {
    const res = await env.DB.prepare('INSERT INTO departments (name_ar, name_en, created_at) VALUES (?, ?, ?)').bind(ar, en, now).run();
    ids.departments.push(res.meta.last_row_id);
  }
  // Saved before the files, so a failure half way can still be cleaned up from the settings page.
  await setSettingStmt(env, 'demo_ids', JSON.stringify(ids)).run();
  for (const [dept, name, nameEn, number, type, issued, expires, extra] of DEMO_FILES) {
    const key = `pdf/${crypto.randomUUID()}.pdf`;
    await env.FILES.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } });
    const res = await env.DB.prepare(
      `INSERT INTO files (department_id, name, name_en, file_number, doc_type, issue_date, expiry_date, under_review, pdf_key, pdf_name, pdf_size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        ids.departments[dept],
        name,
        nameEn,
        number,
        typeKeys.has(type) ? type : types[0].key,
        plusDays(today, issued),
        expires === null ? null : plusDays(today, expires),
        extra?.under_review ? 1 : 0,
        key,
        number + '.pdf',
        pdf.byteLength,
        now,
        now,
      )
      .run();
    ids.files.push(res.meta.last_row_id);
    await setSettingStmt(env, 'demo_ids', JSON.stringify(ids)).run();
  }
  await logStmt(env, user, 'demo_add', 'system', null, null, { files: ids.files.length }).run();
  return { ok: true, files: ids.files.length, departments: ids.departments.length };
}

// Removes only what addDemo created. A department someone has since used (a real file or user) is kept.
export async function removeDemo(env, user) {
  const ids = demoIds(await getSettings(env));
  if (!ids) fail(404, 'demo_none');
  let files = 0;
  for (const id of ids.files) {
    const f = await env.DB.prepare('SELECT pdf_key FROM files WHERE id = ?').bind(id).first();
    if (!f) continue;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id),
      env.DB.prepare('DELETE FROM acks WHERE file_id = ?').bind(id),
      env.DB.prepare('DELETE FROM file_texts WHERE file_id = ?').bind(id),
    ]);
    if (f.pdf_key) await env.FILES.delete(f.pdf_key);
    files++;
  }
  let kept = 0;
  for (const id of ids.departments) {
    const used = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM files WHERE department_id = ?1) + (SELECT COUNT(*) FROM users WHERE department_id = ?1) AS n',
    )
      .bind(id)
      .first();
    if (used.n > 0) kept++;
    else await env.DB.prepare('DELETE FROM departments WHERE id = ?').bind(id).run();
  }
  await env.DB.batch([env.DB.prepare("DELETE FROM settings WHERE key = 'demo_ids'"), logStmt(env, user, 'demo_remove', 'system', null, null, { files })]);
  return { ok: true, files, kept_departments: kept };
}

// Runs once a day (cron) or on demand from the settings page.
export async function runReminders(env, actor) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results: files } = await env.DB.prepare(
    `SELECT f.*, d.name_ar AS dept_ar, d.name_en AS dept_en
       FROM files f JOIN departments d ON d.id = f.department_id
      WHERE (f.expiry_date IS NOT NULL AND f.under_review = 0) OR f.notify_date IS NOT NULL`,
  ).all();

  // Sample files must not email anyone.
  const demoFiles = new Set(demoIds(settings)?.files || []);
  const due = [];
  for (const f of files) {
    if (demoFiles.has(f.id)) continue;
    const st = statusOf(f, today, settings.near_days);
    const reasons = [];
    if (f.notify_date && f.notify_date <= today && f.notify_date_sent !== f.notify_date) reasons.push('custom');
    if (st.status === 'near' || st.status === 'expired') {
      const firstTime = f.last_notified_status !== st.status;
      const repeatDue = settings.repeat_days > 0 && f.last_notified_on && diffDays(today, f.last_notified_on) >= settings.repeat_days;
      if (firstTime || repeatDue) reasons.push(st.status);
    }
    if (reasons.length) due.push({ f, st, reasons });
  }
  if (!due.length) return { ok: true, files: 0, emails: 0 };
  if (!mailReady(settings)) return { ok: false, error: 'mail_not_configured', files: due.length, emails: 0 };

  // Recipients: super admins get everything, department admins get their own department.
  const { results: admins } = await env.DB.prepare("SELECT id, email, role, department_id FROM users WHERE active = 1 AND (role IN ('super_admin', 'systems_admin') OR docs_role = 'dept_admin')").all();
  const messages = [];
  for (const u of admins) {
    const mine = due.filter((x) => isAdmin(u) || u.department_id === x.f.department_id);
    if (mine.length) messages.push({ to: u.email, ...bothLangs(settings, (s) => buildDigest(mine, s)) });
  }
  if (!messages.length) return { ok: true, files: due.length, emails: 0 };

  const result = await sendMail(settings, messages);
  if (!result.ok) {
    await logStmt(env, actor, 'notify_failed', 'system', null, null, { error: result.error, files: due.length }).run();
    return { ok: false, error: result.error, files: due.length, emails: result.sent || 0 };
  }
  const updates = due.map(({ f, st, reasons }) => {
    const statusReason = reasons.find((r) => r !== 'custom');
    return env.DB.prepare('UPDATE files SET last_notified_status = ?, last_notified_on = ?, notify_date_sent = ? WHERE id = ?').bind(
      statusReason ? st.status : f.last_notified_status,
      statusReason ? today : f.last_notified_on,
      reasons.includes('custom') ? f.notify_date : f.notify_date_sent,
      f.id,
    );
  });
  updates.push(logStmt(env, actor, 'notify', 'system', null, null, { files: due.length, emails: messages.length }));
  await env.DB.batch(updates);
  return { ok: true, files: due.length, emails: messages.length };
}

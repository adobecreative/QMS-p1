// Incident reports (OVR): any employee reports from the app or a place's QR code, quality receives and classifies it,
// sends it to a person for a reply or for action (always a correction and an improvement), then closes it.
// Who reported is kept in its own table (ovr_reporters) and only the quality manager ever reads it.
// The patient's file number and name show only to quality staff, the reporter and the people the report is sent to.
// Emails and push notifications never carry the reporter's or the patient's name: only the number, type and place.
import { getUser, readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { sendPush } from '../lib/push.js';
import { escHtml, fail, json, nowIso, optDate, sha256Hex, str, toHex, todayIn } from '../lib/util.js';
import { plusDays } from './docs.js';
import { MAX_PHOTO_BYTES, hashIp, photoType } from './tickets.js';

export const OVR_HARMS = ['near_miss', 'no_harm', 'minor', 'moderate', 'major', 'sentinel'];
export const SEVERE = ['major', 'sentinel'];
// Days from the report to closing it, by harm. Major harm and sentinel events go through a root cause analysis.
export const CLOSE_DAYS = { near_miss: 14, no_harm: 14, minor: 14, moderate: 7, major: 45, sentinel: 45 };
export const REPLY_WORKDAYS = 3; // a reply is due this many working days after the report is sent
export const OVR_PER_HOUR = 20; // reports per device address and hour
export const OVR_STATUS = ['new', 'review', 'reply', 'action', 'closed'];
const OPEN = "o.status <> 'closed'";

// Working days in Saudi Arabia: Friday and Saturday off.
export function plusWorkdays(day, n) {
  let d = day;
  let left = n;
  while (left > 0) {
    d = plusDays(d, 1);
    const w = new Date(d + 'T00:00:00Z').getUTCDay();
    if (w !== 5 && w !== 6) left--;
  }
  return d;
}

// What each person may do. quality is 'admin' for the system admins (see withAccess).
// Only an account whose own quality role is "quality manager" sees who reported.
export function ovrRole(u) {
  const q = u.quality || 'none';
  const officer = q === 'admin' || q === 'manager' || q === 'assessor';
  return { officer, manager: q === 'admin' || q === 'manager', viewer: officer || q === 'viewer', seesReporter: u.quality_role === 'manager' };
}

/* --------------------------- starter categories --------------------------- */

// [name_ar, name_en, chapter, [[sub_ar, sub_en, sentinel?], ...]]. Added once; quality edits them after.
export const OVR_STARTER = [
  ['الأدوية', 'Medication', 'MM', [
    ['خطأ وصف', 'Prescribing error'], ['خطأ صرف', 'Dispensing error'], ['خطأ في الجرعة', 'Wrong dose'], ['خطأ في الوقت', 'Wrong time'],
    ['خطأ في طريقة الإعطاء', 'Wrong route'], ['دواء لمريض خطأ', 'Wrong patient'], ['دواء عالي الخطورة', 'High-alert medication'],
    ['تفاعل دوائي أو حساسية', 'Adverse reaction or allergy'], ['تخزين أو انتهاء صلاحية', 'Storage or expiry'], ['نقص مخزون', 'Out of stock']]],
  ['السقوط', 'Falls', 'NR', [
    ['سقوط من السرير', 'Fall from bed'], ['سقوط أثناء المشي', 'Fall while walking'], ['سقوط في دورة المياه', 'Fall in the bathroom'],
    ['سقوط من كرسي أو نقالة', 'Fall from chair or stretcher'], ['سقوط زائر أو موظف', 'Visitor or staff fall'], ['خطورة عالية بدون احتياطات', 'High risk without precautions']]],
  ['التعرف على المريض', 'Patient identification', 'PC', [
    ['سوار هوية مفقود أو خاطئ', 'Missing or wrong ID band'], ['عينة بدون ملصق', 'Unlabelled specimen'], ['إجراء لمريض خطأ', 'Procedure on the wrong patient'],
    ['تسليم مولود لعائلة خطأ', 'Infant discharged to the wrong family', 1]]],
  ['مكافحة العدوى', 'Infection control', 'IPC', [
    ['عدوى مكتسبة', 'Healthcare-associated infection'], ['وخز إبرة', 'Needle-stick injury'], ['تعرض لسوائل الجسم', 'Body fluid exposure'],
    ['عدم الالتزام بالعزل', 'Isolation not followed'], ['نظافة اليدين', 'Hand hygiene'], ['خلل في التعقيم', 'Sterilisation failure'], ['النفايات الطبية', 'Medical waste']]],
  ['الأجهزة والمعدات', 'Equipment and devices', 'FMS', [
    ['عطل أثناء الاستخدام', 'Failure during use'], ['جهاز غير معاير', 'Not calibrated'], ['نقص مستلزمات', 'Missing supplies'],
    ['إصابة بسبب جهاز', 'Injury from a device'], ['استخدام خاطئ', 'Wrong use']]],
  ['المبنى والبيئة', 'Building and environment', 'FMS', [
    ['حريق أو دخان', 'Fire or smoke'], ['تسرب مياه', 'Water leak'], ['انقطاع كهرباء', 'Power cut'], ['الغازات الطبية', 'Medical gases'],
    ['انسكاب مواد خطرة', 'Hazardous spill'], ['أرضية زلقة', 'Slippery floor']]],
  ['السلوك والأمن', 'Behaviour and security', 'LD', [
    ['اعتداء لفظي', 'Verbal abuse'], ['اعتداء جسدي', 'Physical assault'], ['تحرش', 'Harassment'], ['هروب مريض', 'Patient absconded'],
    ['سرقة أو فقدان ممتلكات', 'Theft or lost property'], ['اختطاف رضيع', 'Infant abduction', 1], ['إيذاء النفس أو انتحار', 'Self-harm or suicide', 1]]],
  ['الرعاية السريرية', 'Clinical care', 'PC', [
    ['تأخر التشخيص أو العلاج', 'Delay in diagnosis or treatment'], ['تدهور لم يُكتشف', 'Missed deterioration'], ['قرحة فراش', 'Pressure injury'],
    ['مضاعفات إجراء', 'Procedure complication'], ['إعادة دخول غير مخططة', 'Unplanned readmission'], ['التغذية', 'Nutrition'],
    ['وفاة غير متوقعة', 'Unexpected death', 1]]],
  ['الجراحة والتخدير', 'Surgery and anaesthesia', 'OR', [
    ['جراحة موضع خطأ أو مريض خطأ', 'Wrong site or wrong patient surgery', 1], ['جسم متبقٍ بعد العملية', 'Retained foreign object', 1],
    ['مضاعفات تخدير', 'Anaesthesia complication'], ['إلغاء عملية', 'Cancelled surgery'], ['عدم تطبيق قائمة التحقق', 'Safety checklist not done']]],
  ['المختبر والدم والأشعة', 'Laboratory, blood and radiology', 'LB', [
    ['عينة مفقودة أو مرفوضة', 'Lost or rejected specimen'], ['نتيجة حرجة لم تُبلَّغ', 'Critical result not reported'], ['تفاعل نقل دم', 'Transfusion reaction'],
    ['دم غير متوافق', 'ABO-incompatible transfusion', 1], ['تصوير لمريض خطأ', 'Imaging on the wrong patient'], ['تعرض إشعاعي', 'Radiation exposure']]],
  ['التوثيق والتواصل', 'Documentation and communication', 'MOI', [
    ['تسليم مناوبة ناقص', 'Incomplete handover'], ['أمر شفهي غير موثق', 'Verbal order not documented'], ['موافقة مفقودة', 'Missing consent'],
    ['ملف ناقص', 'Incomplete record'], ['اختراق خصوصية', 'Privacy breach']]],
  ['سلامة الموظفين', 'Staff safety', 'FMS', [['إصابة عمل', 'Work injury'], ['إجهاد', 'Strain'], ['تعرض كيميائي', 'Chemical exposure']]],
  ['إداري وانضباط', 'Administrative', 'LD', [
    ['غياب عن اجتماع لجنة', 'Absent from a committee meeting'], ['عدم التزام بسياسة', 'Policy not followed'], ['نقص كادر', 'Staff shortage'], ['سلوك مهني', 'Professional conduct']]],
  ['أخرى', 'Other', null, []],
];

export async function seedOvrCategories(env) {
  const flag = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ovr_cats_seeded'").first();
  if (flag) return;
  const now = nowIso();
  const stmts = [];
  OVR_STARTER.forEach(([ar, en, ch, subs], i) => {
    const sort = (i + 1) * 10;
    stmts.push(env.DB.prepare('INSERT INTO ovr_categories (parent_id, name_ar, name_en, chapter, sentinel, sort, active, created_at) VALUES (NULL, ?, ?, ?, 0, ?, 1, ?)').bind(ar, en, ch, sort, now));
    subs.forEach(([sar, sen, sentinel], j) =>
      stmts.push(
        env.DB.prepare(
          `INSERT INTO ovr_categories (parent_id, name_ar, name_en, chapter, sentinel, sort, active, created_at)
           SELECT id, ?, ?, NULL, ?, ?, 1, ? FROM ovr_categories WHERE parent_id IS NULL AND name_ar = ? ORDER BY id DESC LIMIT 1`,
        ).bind(sar, sen, sentinel ? 1 : 0, j + 1, now, ar),
      ),
    );
  });
  stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ovr_cats_seeded', ?) ON CONFLICT(key) DO NOTHING").bind(now));
  await env.DB.batch(stmts);
}

const allCategories = (env, activeOnly) =>
  env.DB.prepare(`SELECT id, parent_id, name_ar, name_en, chapter, sentinel, sort, active FROM ovr_categories ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`).all().then((r) => r.results);

/* ------------------------------ notifications ----------------------------- */

const MAIL = {
  ar: {
    dir: 'rtl',
    kind: {
      new: 'بلاغ حادث جديد', severe: 'بلاغ حادث جسيم', route_reply: 'بلاغ حادث محوّل إليك للرد', route_action: 'بلاغ حادث محوّل إليك لاتخاذ إجراء',
      reply: 'تم الرد على بلاغ حادث', action: 'تم تسجيل إجراء على بلاغ حادث', closed: 'تم إغلاق بلاغ الحادث', reopened: 'أعيد فتح بلاغ الحادث',
      late_task: 'تذكير: بلاغ حادث متأخر الرد', late_ovr: 'بلاغات حوادث تجاوزت موعد الإغلاق', received: 'تم استلام بلاغك',
    },
    labels: { type: 'النوع', place: 'المكان', harm: 'الضرر', due: 'الموعد', note: 'ملاحظة' },
    harm: { near_miss: 'قريب من الخطأ', no_harm: 'بدون ضرر', minor: 'ضرر بسيط', moderate: 'ضرر متوسط', major: 'ضرر جسيم', sentinel: 'حدث جسيم' },
    open: 'فتح البلاغ',
    footer: (app) => `رسالة تلقائية من ${app}.`,
  },
  en: {
    dir: 'ltr',
    kind: {
      new: 'New incident report', severe: 'Serious incident report', route_reply: 'Incident report sent to you for a reply', route_action: 'Incident report sent to you for action',
      reply: 'Reply on an incident report', action: 'Action recorded on an incident report', closed: 'Incident report closed', reopened: 'Incident report reopened',
      late_task: 'Reminder: incident report reply overdue', late_ovr: 'Incident reports past their closing date', received: 'Your report was received',
    },
    labels: { type: 'Type', place: 'Place', harm: 'Harm', due: 'Due', note: 'Note' },
    harm: { near_miss: 'Near miss', no_harm: 'No harm', minor: 'Minor harm', moderate: 'Moderate harm', major: 'Major harm', sentinel: 'Sentinel event' },
    open: 'Open the report',
    footer: (app) => `Automatic message from ${app}.`,
  },
};

const ovrLink = (settings, id) => (settings.site_url || '') + '/#/ovr/ovrs/' + id;
const typeText = (o, en) => [en ? o.cat_en : o.cat_ar, en ? o.sub_en : o.sub_ar].filter(Boolean).join(' / ');
const placeText = (o, en) => (o.location_id ? (en ? o.loc_en : o.loc_ar) : o.place_text) || (en ? o.dept_en : o.dept_ar) || '';

// One email (both languages) and one push to each person. Never names the reporter or the patient.
export async function notifyOvr(env, settings, userIds, kind, o, extra = {}) {
  const ids = [...new Set(userIds.filter((x) => Number.isInteger(x)))];
  if (!ids.length) return;
  const { results: people } = await env.DB.prepare(`SELECT id, email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const harm = o.harm_final || o.harm;
  const urgent = SEVERE.includes(harm) || kind === 'severe';
  const jobs = [];
  if (people.length && mailReady(settings)) {
    const mail = bothLangs(settings, (s) => {
      const en = s.email_lang === 'en';
      const L = MAIL[en ? 'en' : 'ar'];
      const app = appName(s, s.email_lang);
      const align = L.dir === 'rtl' ? 'right' : 'left';
      const row = (k, v) => (v ? `<tr><td style="padding:4px 10px;color:#6e6553;text-align:${align}">${escHtml(L.labels[k])}</td><td style="padding:4px 10px;text-align:${align}">${escHtml(v)}</td></tr>` : '');
      const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(s)}
        <p style="font-size:16px;font-weight:bold;color:${urgent ? '#7d2f27' : '#1f1a12'}">${escHtml(L.kind[kind])} <span dir="ltr">#${o.id}</span></p>
        <table style="border-collapse:collapse">${row('type', typeText(o, en))}${row('place', placeText(o, en))}${row('harm', L.harm[harm])}${row('due', extra.due)}${row('note', extra.note)}</table>
        <p style="margin:20px 0"><a href="${escHtml(ovrLink(s, o.id))}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
      return { subject: `${L.kind[kind]} #${o.id} - ${app}`, html };
    });
    jobs.push(sendMail(settings, people.map((p) => ({ to: p.email, ...mail }))));
  }
  jobs.push(
    sendPush(env, ids, (lang) => {
      const en = lang === 'en';
      const L = MAIL[en ? 'en' : 'ar'];
      return { title: `${L.kind[kind]} #${o.id}`, body: [typeText(o, en), placeText(o, en), L.harm[harm]].filter(Boolean).join(' · '), url: '/#/ovr/ovrs/' + o.id, tag: 'ovr-' + o.id, urgent };
    }),
  );
  await Promise.all(jobs.map((p) => p.catch((e) => console.error('ovr notify', e))));
}

const qualityStaffIds = (env) => env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role IN ('assessor', 'manager')").all().then((r) => r.results.map((x) => x.id));
const qualityManagerIds = (env) => env.DB.prepare("SELECT id FROM users WHERE active = 1 AND quality_role = 'manager'").all().then((r) => r.results.map((x) => x.id));
// Leadership is told at once of major harm and sentinel events.
const leaderIds = (env) => env.DB.prepare("SELECT id FROM users WHERE active = 1 AND role = 'super_admin' AND id <> (SELECT MIN(id) FROM users)").all().then((r) => r.results.map((x) => x.id));

/* --------------------------------- reading -------------------------------- */

const SELECT = `SELECT o.*, c.name_ar AS cat_ar, c.name_en AS cat_en, c.chapter AS chapter, sc.name_ar AS sub_ar, sc.name_en AS sub_en,
       d.name_ar AS dept_ar, d.name_en AS dept_en, l.name_ar AS loc_ar, l.name_en AS loc_en
  FROM ovr o LEFT JOIN ovr_categories c ON c.id = o.category_id LEFT JOIN ovr_categories sc ON sc.id = o.sub_id
  LEFT JOIN departments d ON d.id = o.department_id LEFT JOIN locations l ON l.id = o.location_id`;

const getOvr = (env, id) => env.DB.prepare(`${SELECT} WHERE o.id = ?`).bind(id).first();

// The fields every reader gets; the patient only when allowed.
function ovrOut(o, today, patient) {
  const out = {
    id: o.id, status: o.status, source: o.source, occurred_at: o.occurred_at, created_at: o.created_at, updated_at: o.updated_at,
    department_id: o.department_id, dept_ar: o.dept_ar || '', dept_en: o.dept_en || '', location_id: o.location_id, loc_ar: o.loc_ar || '', loc_en: o.loc_en || '', place_text: o.place_text || '',
    category_id: o.category_id, sub_id: o.sub_id, cat_ar: o.cat_ar || '', cat_en: o.cat_en || '', sub_ar: o.sub_ar || '', sub_en: o.sub_en || '', chapter: o.chapter || '',
    harm: o.harm, harm_final: o.harm_final || null, description: o.description, immediate_action: o.immediate_action || '', involved: o.involved || '',
    patient: !!o.patient, has_photo: !!o.photo_key, due: o.due, late: o.status !== 'closed' && !!o.due && o.due < today,
    closed_at: o.closed_at || null, closed_by: o.closed_by || null, close_note: o.close_note || '',
  };
  if (patient && o.patient) Object.assign(out, { patient_mrn: o.patient_mrn || '', patient_name: o.patient_name || '', patient_age: o.patient_age || '', patient_sex: o.patient_sex || '' });
  return out;
}

// The incident's date and time from the form (a local date-time from the phone), kept as written.
const occurredAt = (v) => {
  const s = str(v, 20);
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s) || Number.isNaN(Date.parse(s.slice(0, 10)))) fail(400, 'ovr_bad_time');
  return s;
};

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Category and sub-category: active, the sub belonging to the category (needed when it has any).
async function checkCategory(env, catId, subId) {
  const cat = catId ? await env.DB.prepare('SELECT id, active FROM ovr_categories WHERE id = ? AND parent_id IS NULL').bind(catId).first() : null;
  if (!cat || !cat.active) fail(400, 'ovr_bad_category');
  const subs = await env.DB.prepare('SELECT id, sentinel FROM ovr_categories WHERE parent_id = ? AND active = 1').bind(catId).all();
  if (!subs.results.length) return { sub: null, sentinel: false };
  const sub = subs.results.find((s) => s.id === subId);
  if (!sub) fail(400, 'ovr_bad_sub');
  return { sub: sub.id, sentinel: !!sub.sentinel };
}

/* ------------------------------ public routes ----------------------------- */

// /api/public/ovr/...: the report form (signed in or with an employee number) and the tracking link.
export async function handlePublicOvr(request, env, url, seg, method, ctx) {
  // GET /public/ovr/form?loc=<code>: categories, departments and places for the form.
  if (method === 'GET' && seg[2] === 'form' && seg.length === 3) {
    await seedOvrCategories(env);
    const code = str(url.searchParams.get('loc'), 40);
    const [categories, { results: departments }, loc, { results: places }, user] = await Promise.all([
      allCategories(env, true),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 0 OR is_team IS NULL ORDER BY name_ar').all(),
      code ? env.DB.prepare('SELECT id, name_ar, name_en, department_id FROM locations WHERE code = ? AND active = 1').bind(code).first() : null,
      env.DB.prepare('SELECT id, name_ar, name_en FROM locations WHERE active = 1 ORDER BY name_ar LIMIT 1000').all(),
      getUser(request, env),
    ]);
    const staffN = user ? 0 : (await env.DB.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1').first()).n;
    return json({ categories, departments, places, location: loc || null, bad_location: !!code && !loc, signed_in: !!user, staff_check: staffN > 0, harms: OVR_HARMS });
  }

  // POST /public/ovr (multipart): a new report.
  if (method === 'POST' && seg.length === 2) {
    const ipHash = await hashIp(request);
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const hits = await env.DB.prepare('SELECT COUNT(*) AS n FROM public_hits WHERE ip_hash = ? AND at > ?').bind('ovr:' + ipHash, hourAgo).first();
    if (hits.n >= OVR_PER_HOUR) fail(429, 'too_many_requests');
    let form;
    try {
      form = await request.formData();
    } catch {
      fail(400, 'invalid_form');
    }
    const g = (k, n) => str(form.get(k) || '', n);
    if (g('website', 100)) return json({ ok: true, id: 0 }); // filled only by bots
    const user = await getUser(request, env);
    const settings = await getSettings(env);
    const today = todayIn(settings.timezone);

    // Who reported: the account, or an employee number from the staff list.
    let reporter;
    if (user) reporter = { user_id: user.id, emp_no: null, name: user.name, department_id: user.department_id ?? null };
    else {
      const empNo = g('emp_no', 30).replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x660));
      if (!empNo) fail(400, 'ovr_emp_required');
      const m = await env.DB.prepare('SELECT name, department_id FROM staff WHERE emp_no = ? AND active = 1').bind(empNo).first();
      if (m) reporter = { user_id: null, emp_no: empNo, name: m.name, department_id: m.department_id ?? null };
      else {
        const anyStaff = await env.DB.prepare('SELECT 1 FROM staff WHERE active = 1 LIMIT 1').first();
        if (anyStaff) fail(400, 'ovr_emp_unknown');
        const name = g('reporter_name', 100);
        if (!name) fail(400, 'name_required');
        reporter = { user_id: null, emp_no: empNo, name, department_id: null };
      }
    }

    const description = g('description', 3000);
    if (description.length < 5) fail(400, 'ovr_desc_required');
    const occurred = occurredAt(g('occurred_at', 20));
    if (occurred.slice(0, 10) > plusDays(today, 1)) fail(400, 'ovr_bad_time');
    const departmentId = toId(g('department_id', 12));
    if (!departmentId || !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(departmentId).first())) fail(400, 'ovr_dept_required');
    const code = g('loc', 40);
    const loc = code
      ? await env.DB.prepare('SELECT id FROM locations WHERE code = ? AND active = 1').bind(code).first()
      : toId(g('location_id', 12)) ? await env.DB.prepare('SELECT id FROM locations WHERE id = ? AND active = 1').bind(toId(g('location_id', 12))).first() : null;
    const categoryId = toId(g('category_id', 12));
    const { sub, sentinel } = await checkCategory(env, categoryId, toId(g('sub_id', 12)));
    let harm = g('harm', 20);
    if (!OVR_HARMS.includes(harm)) fail(400, 'ovr_bad_harm');
    if (sentinel) harm = 'sentinel';
    const patient = g('patient', 1) === '1';
    const mrn = g('patient_mrn', 40);
    const pname = g('patient_name', 120);
    if (patient && (!mrn || !pname)) fail(400, 'ovr_patient_required');

    let photo = null;
    const f = form.get('photo');
    if (f && typeof f === 'object' && f.size) {
      if (f.size > MAX_PHOTO_BYTES) fail(413, 'photo_too_large');
      const bytes = await f.arrayBuffer();
      const type = photoType(bytes);
      if (!type) fail(400, 'photo_bad_type');
      photo = { bytes, type, key: `ovr/${crypto.randomUUID()}` };
    }
    if (photo) await env.FILES.put(photo.key, photo.bytes, { httpMetadata: { contentType: photo.type } });

    const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const now = nowIso();
    let id;
    try {
      const res = await env.DB.prepare(
        `INSERT INTO ovr (status, source, occurred_at, department_id, location_id, place_text, category_id, sub_id, harm, description, immediate_action, involved,
                          patient, patient_mrn, patient_name, patient_age, patient_sex, photo_key, photo_type, track_hash, due, created_at, updated_at)
         VALUES ('new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          user ? 'staff' : 'qr', occurred, departmentId, loc ? loc.id : null, g('place_text', 200) || null, categoryId, sub, harm, description,
          g('immediate_action', 1000) || null, g('involved', 500) || null, patient ? 1 : 0, patient ? mrn : null, patient ? pname : null,
          patient ? g('patient_age', 10) || null : null, patient && ['m', 'f'].includes(g('patient_sex', 1)) ? g('patient_sex', 1) : null,
          photo ? photo.key : null, photo ? photo.type : null, await sha256Hex(token), plusDays(today, CLOSE_DAYS[harm]), now, now,
        )
        .run();
      id = res.meta.last_row_id;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO ovr_reporters (ovr_id, user_id, emp_no, name, department_id) VALUES (?, ?, ?, ?, ?)').bind(id, reporter.user_id, reporter.emp_no, reporter.name, reporter.department_id),
        env.DB.prepare("INSERT INTO ovr_steps (ovr_id, at, kind, by_id, by_name, text) VALUES (?, ?, 'create', NULL, NULL, NULL)").bind(id, now),
        env.DB.prepare('INSERT INTO public_hits (ip_hash, at) VALUES (?, ?)').bind('ovr:' + ipHash, now),
        logStmt(env, null, 'create', 'ovr', id, '#' + id),
      ]);
    } catch (e) {
      if (photo) await env.FILES.delete(photo.key);
      throw e;
    }
    const o = await getOvr(env, id);
    const job = (async () => {
      await notifyOvr(env, settings, await qualityStaffIds(env), SEVERE.includes(harm) ? 'severe' : 'new', o);
      if (SEVERE.includes(harm)) await notifyOvr(env, settings, await leaderIds(env), 'severe', o);
      if (user) await notifyOvr(env, settings, [user.id], 'received', o);
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    else await job;
    return json({ ok: true, id, track: token });
  }

  // GET /public/ovr/<id>?k=<token>: where a report stands, for the person who sent it (no details).
  if (method === 'GET' && seg.length === 3 && /^\d+$/.test(seg[2])) {
    const k = str(url.searchParams.get('k'), 64);
    if (!/^[0-9a-f]{32}$/.test(k)) fail(404, 'not_found');
    const o = await env.DB.prepare(`${SELECT} WHERE o.id = ? AND o.track_hash = ?`).bind(Number(seg[2]), await sha256Hex(k)).first();
    if (!o) fail(404, 'not_found');
    return json({ ovr: { id: o.id, status: o.status, created_at: o.created_at, closed_at: o.closed_at, cat_ar: o.cat_ar, cat_en: o.cat_en, sub_ar: o.sub_ar, sub_en: o.sub_en } });
  }
  fail(404, 'not_found');
}

/* ----------------------------- signed-in routes ---------------------------- */

// After a task is added, answered or withdrawn: waiting for action, for a reply, or back with quality.
const syncStatusStmt = (env, id) =>
  env.DB.prepare(
    `UPDATE ovr SET status = CASE
        WHEN status = 'closed' THEN 'closed'
        WHEN EXISTS (SELECT 1 FROM ovr_tasks WHERE ovr_id = ?1 AND status = 'open' AND kind = 'action') THEN 'action'
        WHEN EXISTS (SELECT 1 FROM ovr_tasks WHERE ovr_id = ?1 AND status = 'open') THEN 'reply'
        WHEN status = 'new' THEN 'new' ELSE 'review' END, updated_at = ?2 WHERE id = ?1`,
  ).bind(id, nowIso());

const stepStmt = (env, id, kind, user, text, toId_) =>
  env.DB.prepare('INSERT INTO ovr_steps (ovr_id, at, kind, by_id, by_name, to_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, nowIso(), kind, user ? user.id : null, user ? user.name : null, toId_ || null, text || null);

export async function handleOvr(request, env, url, seg, method, user, ctx) {
  const role = ovrRole(user);
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);

  /* categories: everyone reads them; the quality manager edits them */
  if (seg[1] === 'cats') {
    await seedOvrCategories(env);
    const cid = /^\d+$/.test(seg[2] || '') ? Number(seg[2]) : null;
    if (method === 'GET' && seg.length === 2) {
      const cats = await allCategories(env, !role.manager);
      const { results: used } = await env.DB.prepare('SELECT category_id AS c, sub_id AS s, COUNT(*) AS n FROM ovr GROUP BY category_id, sub_id').all();
      const n = {};
      for (const u of used) {
        n[u.c] = (n[u.c] || 0) + u.n;
        if (u.s) n[u.s] = (n[u.s] || 0) + u.n;
      }
      return json({ categories: cats.map((c) => ({ ...c, used: n[c.id] || 0 })), can_edit: role.manager });
    }
    if (!role.manager) fail(403, 'forbidden');
    const readCat = async (old) => {
      const body = await readJson(request);
      const next = {
        name_ar: body.name_ar === undefined && old ? old.name_ar : str(body.name_ar, 120),
        name_en: body.name_en === undefined && old ? old.name_en : str(body.name_en, 120),
        chapter: body.chapter === undefined && old ? old.chapter : str(body.chapter, 10).toUpperCase() || null,
        sentinel: body.sentinel === undefined && old ? old.sentinel : body.sentinel ? 1 : 0,
        active: body.active === undefined && old ? old.active : body.active === false || body.active === 0 ? 0 : 1,
        parent_id: old ? old.parent_id : toId(body.parent_id),
      };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      if (!old && next.parent_id && !(await env.DB.prepare('SELECT id FROM ovr_categories WHERE id = ? AND parent_id IS NULL').bind(next.parent_id).first())) fail(400, 'ovr_bad_category');
      if (!next.parent_id) next.sentinel = 0;
      return next;
    };
    if (method === 'POST' && seg.length === 2) {
      const next = await readCat(null);
      const max = await env.DB.prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM ovr_categories WHERE ${next.parent_id ? 'parent_id = ?' : 'parent_id IS NULL'}`).bind(...(next.parent_id ? [next.parent_id] : [])).first();
      const res = await env.DB.prepare('INSERT INTO ovr_categories (parent_id, name_ar, name_en, chapter, sentinel, sort, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(next.parent_id, next.name_ar, next.name_en, next.parent_id ? null : next.chapter, next.sentinel, max.m + (next.parent_id ? 1 : 10), nowIso())
        .run();
      await logStmt(env, user, 'create', 'ovr_category', res.meta.last_row_id, next.name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    const old = cid ? await env.DB.prepare('SELECT * FROM ovr_categories WHERE id = ?').bind(cid).first() : null;
    if (!old) fail(404, 'not_found');
    if (method === 'PUT' && seg.length === 3) {
      const next = await readCat(old);
      await env.DB.batch([
        env.DB.prepare('UPDATE ovr_categories SET name_ar = ?, name_en = ?, chapter = ?, sentinel = ?, active = ? WHERE id = ?').bind(next.name_ar, next.name_en, next.chapter, next.sentinel, next.active, cid),
        logStmt(env, user, 'update', 'ovr_category', cid, next.name_ar, changes(old, next, ['name_ar', 'name_en', 'chapter', 'sentinel', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg.length === 3) {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM ovr WHERE category_id = ?1 OR sub_id = ?1').bind(cid).first();
      if (used.n) fail(409, 'ovr_cat_used');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM ovr_categories WHERE id = ?1 OR parent_id = ?1').bind(cid),
        logStmt(env, user, 'delete', 'ovr_category', cid, old.name_ar),
      ]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* the list: quality sees every report; everyone else their own reports and what was sent to them */
  if (method === 'GET' && seg.length === 1) {
    const [{ results: rows }, { results: tasks }] = await Promise.all([
      role.viewer
        ? env.DB.prepare(`${SELECT} ORDER BY CASE WHEN ${OPEN} THEN 0 ELSE 1 END, o.id DESC LIMIT 3000`).all()
        : env.DB.prepare(
            `${SELECT} WHERE o.id IN (SELECT ovr_id FROM ovr_reporters WHERE user_id = ?1) OR o.id IN (SELECT ovr_id FROM ovr_tasks WHERE user_id = ?1)
              ORDER BY CASE WHEN ${OPEN} THEN 0 ELSE 1 END, o.id DESC LIMIT 1000`,
          ).bind(user.id).all(),
      env.DB.prepare("SELECT ovr_id, kind, due, status, user_id FROM ovr_tasks WHERE status = 'open'").all(),
    ]);
    const mine = role.viewer ? new Set() : new Set((await env.DB.prepare('SELECT ovr_id FROM ovr_reporters WHERE user_id = ?').bind(user.id).all()).results.map((r) => r.ovr_id));
    const reporters = role.seesReporter ? Object.fromEntries((await env.DB.prepare('SELECT ovr_id, name, emp_no FROM ovr_reporters').all()).results.map((r) => [r.ovr_id, r])) : null;
    const list = rows.map((o) => {
      const open = tasks.filter((t) => t.ovr_id === o.id);
      const myTask = open.find((t) => t.user_id === user.id);
      const out = ovrOut(o, today, false);
      out.open_tasks = role.viewer ? open.length : 0;
      out.my_task = myTask ? { kind: myTask.kind, due: myTask.due, late: myTask.due < today } : null;
      out.mine = mine.has(o.id);
      // Before quality has looked, the reporter's own harm shows; after, quality's.
      if (!role.viewer) out.description = out.description.slice(0, 200);
      if (reporters && reporters[o.id]) out.reporter = { name: reporters[o.id].name, emp_no: reporters[o.id].emp_no || '' };
      return out;
    });
    return json({ ovr: list, today, role: { officer: role.officer, manager: role.manager, viewer: role.viewer, sees_reporter: role.seesReporter } });
  }

  // GET /ovr/people: the active accounts a report can be sent to.
  if (method === 'GET' && seg[1] === 'people' && seg.length === 2) {
    if (!role.officer) fail(403, 'forbidden');
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.name, u.name_en, u.job_title, d.name_ar AS dept_ar, d.name_en AS dept_en FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.active = 1 AND u.id <> (SELECT MIN(id) FROM users) ORDER BY u.name`,
    ).all();
    return json({ people: results });
  }

  const id = /^\d+$/.test(seg[1] || '') ? Number(seg[1]) : null;
  const o = id ? await getOvr(env, id) : null;
  if (!o) fail(404, 'not_found');
  const rep = await env.DB.prepare('SELECT user_id, emp_no, name FROM ovr_reporters WHERE ovr_id = ?').bind(id).first();
  const isReporter = !!rep && rep.user_id === user.id;
  const { results: allTasks } = await env.DB.prepare(
    `SELECT t.*, u.name AS user_name, u.name_en AS user_name_en FROM ovr_tasks t LEFT JOIN users u ON u.id = t.user_id WHERE t.ovr_id = ? ORDER BY t.id`,
  ).bind(id).all();
  const myTasks = allTasks.filter((t) => t.user_id === user.id);
  if (!role.viewer && !isReporter && !myTasks.length) fail(404, 'not_found');
  const seesPatient = role.officer || isReporter || myTasks.length > 0;

  if (method === 'GET' && seg.length === 2) {
    const out = ovrOut(o, today, seesPatient);
    out.mine = isReporter;
    if (role.seesReporter && rep) out.reporter = { name: rep.name, emp_no: rep.emp_no || '' };
    const taskOut = (t) => ({
      id: t.id, kind: t.kind, status: t.status, user_id: t.user_id, user_name: t.user_name || '', user_name_en: t.user_name_en || '', due: t.due, late: t.status === 'open' && t.due < today,
      note: t.note || '', routed_by: t.routed_by || '', reply: t.reply || '', correction: t.correction || '', improvement: t.improvement || '', done_at: t.done_at, created_at: t.created_at,
    });
    // Quality sees every task and step; the person a report was sent to, their own tasks; the reporter, neither.
    out.tasks = role.viewer ? allTasks.map(taskOut) : myTasks.map(taskOut);
    if (role.viewer) out.steps = (await env.DB.prepare('SELECT at, kind, by_name, to_id, text FROM ovr_steps WHERE ovr_id = ? ORDER BY id').bind(id).all()).results;
    return json({ ovr: out, today, role: { officer: role.officer, manager: role.manager, viewer: role.viewer, sees_reporter: role.seesReporter } });
  }

  if (method === 'GET' && seg[2] === 'photo' && seg.length === 3) {
    const obj = o.photo_key ? await env.FILES.get(o.photo_key) : null;
    if (!obj) fail(404, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': o.photo_type || 'image/jpeg', 'content-length': String(obj.size), 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
  }

  // POST /ovr/<id>/tasks/<task>: the person it was sent to answers (a reply, or a correction and an improvement).
  if (method === 'POST' && seg[2] === 'tasks' && seg.length === 4) {
    const t = allTasks.find((x) => String(x.id) === seg[3]);
    if (!t) fail(404, 'not_found');
    if (t.user_id !== user.id) fail(403, 'forbidden');
    if (t.status !== 'open' || o.status === 'closed') fail(409, 'ovr_task_done');
    const body = await readJson(request);
    const reply = str(body.reply, 3000);
    const correction = str(body.correction, 2000);
    const improvement = str(body.improvement, 2000);
    if (t.kind === 'reply' && !reply) fail(400, 'ovr_reply_required');
    if (t.kind === 'action' && (!correction || !improvement)) fail(400, 'ovr_action_required');
    await env.DB.batch([
      env.DB.prepare("UPDATE ovr_tasks SET status = 'done', reply = ?, correction = ?, improvement = ?, done_at = ? WHERE id = ?").bind(reply || null, correction || null, improvement || null, nowIso(), t.id),
      stepStmt(env, id, t.kind === 'action' ? 'action' : 'reply', user, null, null),
      syncStatusStmt(env, id),
      logStmt(env, user, t.kind === 'action' ? 'action' : 'reply', 'ovr', id, '#' + id),
    ]);
    later(notifyOvr(env, settings, [t.routed_by_id, ...(await qualityManagerIds(env))], t.kind === 'action' ? 'action' : 'reply', o));
    return json({ ok: true });
  }

  if (!role.officer) fail(403, 'forbidden');

  // PUT /ovr/<id>: quality receives the report and sets the type, harm and department.
  if (method === 'PUT' && seg.length === 2) {
    if (o.status === 'closed') fail(409, 'ovr_closed');
    const body = await readJson(request);
    const catId = body.category_id === undefined ? o.category_id : toId(body.category_id);
    const { sub, sentinel } = await checkCategory(env, catId, body.sub_id === undefined ? o.sub_id : toId(body.sub_id));
    let harmFinal = body.harm_final === undefined ? o.harm_final || o.harm : str(body.harm_final, 20);
    if (!OVR_HARMS.includes(harmFinal)) fail(400, 'ovr_bad_harm');
    if (sentinel) harmFinal = 'sentinel';
    const deptId = body.department_id === undefined ? o.department_id : toId(body.department_id);
    if (!deptId || !(await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(deptId).first())) fail(400, 'ovr_dept_required');
    const due = harmFinal !== (o.harm_final || o.harm) ? plusDays(o.created_at.slice(0, 10), CLOSE_DAYS[harmFinal]) : o.due;
    const first = o.status === 'new';
    const next = { category_id: catId, sub_id: sub, harm_final: harmFinal, department_id: deptId, due };
    await env.DB.batch([
      env.DB.prepare("UPDATE ovr SET category_id = ?, sub_id = ?, harm_final = ?, department_id = ?, due = ?, status = CASE WHEN status = 'new' THEN 'review' ELSE status END, updated_at = ? WHERE id = ?")
        .bind(catId, sub, harmFinal, deptId, due, nowIso(), id),
      stepStmt(env, id, first ? 'receive' : 'classify', user, null, null),
      logStmt(env, user, first ? 'receive' : 'update', 'ovr', id, '#' + id, changes(o, next, ['category_id', 'sub_id', 'harm_final', 'department_id', 'due'])),
    ]);
    // Raised to major harm or a sentinel event: quality and leadership are told at once.
    if (SEVERE.includes(harmFinal) && !SEVERE.includes(o.harm_final || o.harm)) {
      const fresh = await getOvr(env, id);
      later((async () => notifyOvr(env, settings, [...(await qualityStaffIds(env)), ...(await leaderIds(env))], 'severe', fresh))());
    }
    return json({ ok: true });
  }

  // POST /ovr/<id>/route {user_id, kind: reply|action, note, due}: send it to a person.
  if (method === 'POST' && seg[2] === 'route' && seg.length === 3) {
    if (o.status === 'closed') fail(409, 'ovr_closed');
    const body = await readJson(request);
    const kind = body.kind === 'action' ? 'action' : 'reply';
    const to = toId(body.user_id);
    const person = to ? await env.DB.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').bind(to).first() : null;
    if (!person) fail(400, 'ovr_bad_person');
    if (allTasks.some((t) => t.status === 'open' && t.user_id === to && t.kind === kind)) fail(409, 'ovr_task_exists');
    const due = optDate(body.due) || plusWorkdays(today, REPLY_WORKDAYS);
    if (due < today) fail(400, 'invalid_date');
    const note = str(body.note, 1000);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ovr_tasks (ovr_id, kind, user_id, due, status, note, routed_by_id, routed_by, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)")
        .bind(id, kind, to, due, note || null, user.id, user.name, nowIso()),
      env.DB.prepare("UPDATE ovr SET status = 'review' WHERE id = ? AND status = 'new'").bind(id),
      stepStmt(env, id, 'route_' + kind, user, note, to),
      syncStatusStmt(env, id),
      logStmt(env, user, 'route', 'ovr', id, '#' + id, { to: [null, person.name], kind: [null, kind] }),
    ]);
    later(notifyOvr(env, settings, [to], 'route_' + kind, o, { due, note }));
    return json({ ok: true });
  }

  // DELETE /ovr/<id>/tasks/<task>: withdraw an open task (sent to the wrong person).
  if (method === 'DELETE' && seg[2] === 'tasks' && seg.length === 4) {
    const t = allTasks.find((x) => String(x.id) === seg[3]);
    if (!t) fail(404, 'not_found');
    if (t.status !== 'open') fail(409, 'ovr_task_done');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM ovr_tasks WHERE id = ?').bind(t.id),
      stepStmt(env, id, 'withdraw', user, null, t.user_id),
      syncStatusStmt(env, id),
      logStmt(env, user, 'withdraw', 'ovr', id, '#' + id),
    ]);
    return json({ ok: true });
  }

  // POST /ovr/<id>/close {note}: nothing left open; the reporter and everyone it was sent to are told.
  if (method === 'POST' && seg[2] === 'close' && seg.length === 3) {
    if (o.status === 'closed') fail(409, 'ovr_closed');
    if (allTasks.some((t) => t.status === 'open')) fail(409, 'ovr_tasks_open');
    const note = str((await readJson(request)).note, 2000);
    if (!note) fail(400, 'ovr_note_required');
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE ovr SET status = 'closed', closed_at = ?, closed_by = ?, close_note = ?, updated_at = ? WHERE id = ?").bind(now, user.name, note, now, id),
      stepStmt(env, id, 'close', user, note, null),
      logStmt(env, user, 'close', 'ovr', id, '#' + id),
    ]);
    later(notifyOvr(env, settings, [rep && rep.user_id, ...allTasks.map((t) => t.user_id)].filter((x) => x && x !== user.id), 'closed', o));
    return json({ ok: true });
  }

  // POST /ovr/<id>/reopen {note}: the quality manager only.
  if (method === 'POST' && seg[2] === 'reopen' && seg.length === 3) {
    if (!role.manager) fail(403, 'forbidden');
    if (o.status !== 'closed') fail(409, 'ovr_not_closed');
    const note = str((await readJson(request)).note, 2000);
    if (!note) fail(400, 'ovr_note_required');
    await env.DB.batch([
      env.DB.prepare("UPDATE ovr SET status = 'review', closed_at = NULL, closed_by = NULL, close_note = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id),
      stepStmt(env, id, 'reopen', user, note, null),
      syncStatusStmt(env, id),
      logStmt(env, user, 'reopen', 'ovr', id, '#' + id),
    ]);
    return json({ ok: true });
  }

  // DELETE /ovr/<id>: the quality manager removes a report sent by mistake (or a test).
  if (method === 'DELETE' && seg.length === 2) {
    if (!role.manager) fail(403, 'forbidden');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM ovr_tasks WHERE ovr_id = ?').bind(id),
      env.DB.prepare('DELETE FROM ovr_steps WHERE ovr_id = ?').bind(id),
      env.DB.prepare('DELETE FROM ovr_reporters WHERE ovr_id = ?').bind(id),
      env.DB.prepare('DELETE FROM ovr WHERE id = ?').bind(id),
      logStmt(env, user, 'delete', 'ovr', id, '#' + id),
    ]);
    if (o.photo_key) await env.FILES.delete(o.photo_key);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

/* --------------------------------- home ----------------------------------- */

export async function ovrHome(env, user, today) {
  const role = ovrRole(user);
  if (role.viewer) {
    const r = await env.DB.prepare(`SELECT COALESCE(SUM(status = 'new'), 0) AS new, COALESCE(SUM(status <> 'closed'), 0) AS open, COALESCE(SUM(status <> 'closed' AND due < ?), 0) AS late FROM ovr`).bind(today).first();
    return { new: r.new, open: r.open, late: r.late };
  }
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM ovr_tasks WHERE user_id = ?1 AND status = 'open') AS tasks,
            (SELECT COUNT(*) FROM ovr_tasks WHERE user_id = ?1 AND status = 'open' AND due < ?2) AS late,
            (SELECT COUNT(*) FROM ovr o JOIN ovr_reporters r ON r.ovr_id = o.id WHERE r.user_id = ?1) AS mine`,
  ).bind(user.id, today).first();
  return { tasks: r.tasks, late: r.late, mine: r.mine };
}

/* ------------------------------ daily reminders --------------------------- */

// Every morning: each overdue task is reminded once a day to its person and whoever sent it;
// the quality managers get one note listing the reports past their closing date.
export async function runOvrReminders(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results: tasks } = await env.DB.prepare(
    `SELECT t.id, t.ovr_id, t.user_id, t.routed_by_id, t.due FROM ovr_tasks t JOIN ovr o ON o.id = t.ovr_id
      WHERE t.status = 'open' AND o.status <> 'closed' AND t.due < ? AND (t.reminded_on IS NULL OR t.reminded_on < ?) ORDER BY t.due LIMIT 10`,
  ).bind(today, today).all();
  for (const t of tasks) {
    const o = await getOvr(env, t.ovr_id);
    await notifyOvr(env, settings, [t.user_id, t.routed_by_id], 'late_task', o, { due: t.due });
  }
  if (tasks.length) await env.DB.prepare(`UPDATE ovr_tasks SET reminded_on = ? WHERE id IN (${tasks.map((t) => t.id).join(',')})`).bind(today).run();
  let late = 0;
  if (settings.ovr_late_sent !== today) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(id) AS id FROM ovr WHERE status <> 'closed' AND due < ?").bind(today).first();
    late = r.n;
    if (late) {
      const o = await getOvr(env, r.id);
      await notifyOvr(env, settings, await qualityManagerIds(env), 'late_ovr', o, { note: String(late) });
    }
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ovr_late_sent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(today).run();
  }
  return { tasks: tasks.length, late };
}

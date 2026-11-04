// The starting departments, teams, problem types and asset types added once to a new database.
import { logStmt, setSettingStmt } from './db.js';
import { normText, nowIso } from './util.js';

// Ready-made starting data for a hospital, added once by ensureSchema (settings key starter_seeded).
// Nothing is added twice: a department or type whose Arabic or English name already exists is kept,
// and anything deleted afterwards does not come back.
export const STARTER_TEAMS = [
  ['it', 'تقنية المعلومات', 'Information Technology'],
  ['bme', 'الهندسة الطبية', 'Biomedical Engineering'],
  ['maint', 'الصيانة العامة', 'General Maintenance'],
  ['env', 'الخدمات البيئية', 'Environmental Services'],
];
export const STARTER_DEPTS = [
  ['الطوارئ', 'Emergency Department'],
  ['العناية المركزة', 'Intensive Care Unit'],
  ['العناية المركزة لحديثي الولادة', 'Neonatal Intensive Care Unit'],
  ['العناية المركزة للأطفال', 'Pediatric Intensive Care Unit'],
  ['العناية القلبية', 'Coronary Care Unit'],
  ['العمليات', 'Operating Rooms'],
  ['التخدير', 'Anesthesia'],
  ['الباطنية', 'Internal Medicine'],
  ['الجراحة العامة', 'General Surgery'],
  ['العظام', 'Orthopedics'],
  ['النساء والولادة', 'Obstetrics and Gynecology'],
  ['الأطفال', 'Pediatrics'],
  ['القلب', 'Cardiology'],
  ['الكلى والغسيل الكلوي', 'Nephrology and Dialysis'],
  ['الأورام', 'Oncology'],
  ['العيادات الخارجية', 'Outpatient Clinics'],
  ['الأشعة', 'Radiology'],
  ['المختبر', 'Laboratory'],
  ['بنك الدم', 'Blood Bank'],
  ['الصيدلية', 'Pharmacy'],
  ['التعقيم المركزي', 'Central Sterile Services'],
  ['إدارة التمريض', 'Nursing Administration'],
  ['العلاج الطبيعي', 'Physical Therapy'],
  ['التغذية', 'Nutrition Services'],
  ['الجودة وسلامة المرضى', 'Quality and Patient Safety'],
  ['مكافحة العدوى', 'Infection Control'],
  ['السجلات الطبية', 'Medical Records'],
  ['الموارد البشرية', 'Human Resources'],
  ['المالية', 'Finance'],
  ['المشتريات والمستودعات', 'Procurement and Supply'],
  ['الأمن والسلامة', 'Security and Safety'],
  ['الإدارة العامة', 'Administration'],
];
// [team key, Arabic, English, priority 1 = critical ... 4 = low]
export const STARTER_CATEGORIES = [
  ['it', 'كمبيوتر لا يعمل', 'Computer not working', 3],
  ['it', 'طابعة', 'Printer', 4],
  ['it', 'الشبكة أو الإنترنت', 'Network or internet', 2],
  ['it', 'نظام المعلومات الصحية', 'Hospital information system', 2],
  ['it', 'البريد الإلكتروني أو كلمة المرور', 'Email or password', 4],
  ['it', 'الهاتف الداخلي', 'Desk phone', 3],
  ['bme', 'عطل جهاز طبي', 'Medical device fault', 2],
  ['bme', 'جهاز مراقبة المريض', 'Patient monitor', 1],
  ['bme', 'مضخة المحاليل', 'Infusion pump', 1],
  ['bme', 'جهاز التنفس الصناعي', 'Ventilator', 1],
  ['bme', 'جهاز الصدمات الكهربائية', 'Defibrillator', 1],
  ['bme', 'سرير المريض', 'Patient bed', 3],
  ['bme', 'معايرة جهاز طبي', 'Device calibration', 3],
  ['maint', 'التكييف', 'Air conditioning', 2],
  ['maint', 'الكهرباء والإنارة', 'Electricity and lighting', 2],
  ['maint', 'السباكة أو تسرب المياه', 'Plumbing or water leak', 2],
  ['maint', 'الغازات الطبية', 'Medical gases', 1],
  ['maint', 'المصاعد', 'Elevators', 2],
  ['maint', 'الأبواب والأقفال', 'Doors and locks', 3],
  ['maint', 'النجارة والأثاث', 'Carpentry and furniture', 4],
  ['env', 'النظافة', 'Cleaning', 3],
  ['env', 'النفايات الطبية', 'Medical waste', 2],
  ['env', 'مكافحة الحشرات', 'Pest control', 3],
];
export const sameName = (row, ar, en) => normText(row.name_ar) === normText(ar) || String(row.name_en || '').trim().toLowerCase() === en.toLowerCase();

// The four teams (an existing department of that name becomes a team), the vital departments, then the
// common problem types, each sent to its team.
export async function seedStarter(env) {
  const now = nowIso();
  const { results: depts } = await env.DB.prepare('SELECT id, name_ar, name_en, is_team FROM departments').all();
  const stmts = [];
  for (const [, ar, en] of STARTER_TEAMS) {
    const found = depts.find((d) => sameName(d, ar, en));
    if (!found) stmts.push(env.DB.prepare('INSERT INTO departments (name_ar, name_en, is_team, created_at) VALUES (?, ?, 1, ?)').bind(ar, en, now));
    else if (!found.is_team) stmts.push(env.DB.prepare('UPDATE departments SET is_team = 1 WHERE id = ?').bind(found.id));
  }
  for (const [ar, en] of STARTER_DEPTS) {
    if (!depts.some((d) => sameName(d, ar, en)) && !STARTER_TEAMS.some(([, tar, ten]) => sameName({ name_ar: tar, name_en: ten }, ar, en))) {
      stmts.push(env.DB.prepare('INSERT INTO departments (name_ar, name_en, is_team, created_at) VALUES (?, ?, 0, ?)').bind(ar, en, now));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  const [{ results: teams }, { results: cats }] = await Promise.all([
    env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 1').all(),
    env.DB.prepare('SELECT name_ar, name_en FROM ticket_categories').all(),
  ]);
  const teamId = Object.fromEntries(STARTER_TEAMS.map(([key, ar, en]) => [key, (teams.find((d) => sameName(d, ar, en)) || {}).id]));
  const add = STARTER_CATEGORIES.filter(([key, ar, en]) => teamId[key] && !cats.some((c) => sameName(c, ar, en))).map(([key, ar, en, priority]) =>
    env.DB.prepare('INSERT INTO ticket_categories (name_ar, name_en, team_id, priority, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(ar, en, teamId[key], priority, now),
  );
  await env.DB.batch([...add, setSettingStmt(env, 'starter_seeded', '1'), logStmt(env, null, 'starter', 'system', null, null, { departments: stmts.length, categories: add.length })]);
}

// Common hospital device types, once per database, for the starter teams that exist.
export const STARTER_ASSET_TYPES = [
  ['bme', 'جهاز تنفس صناعي', 'Ventilator'],
  ['bme', 'جهاز مراقبة المريض', 'Patient monitor'],
  ['bme', 'مضخة محاليل', 'Infusion pump'],
  ['bme', 'مضخة حقن', 'Syringe pump'],
  ['bme', 'جهاز صدمات القلب', 'Defibrillator'],
  ['bme', 'جهاز تخطيط القلب', 'ECG machine'],
  ['bme', 'جهاز شفط', 'Suction machine'],
  ['bme', 'جهاز تخدير', 'Anesthesia machine'],
  ['bme', 'جهاز أشعة سينية', 'X-ray machine'],
  ['bme', 'جهاز موجات فوق صوتية', 'Ultrasound machine'],
  ['bme', 'جهاز غسيل كلوي', 'Dialysis machine'],
  ['bme', 'حاضنة أطفال', 'Infant incubator'],
  ['bme', 'جهاز تعقيم', 'Sterilizer'],
  ['bme', 'طاولة عمليات', 'Operating table'],
  ['bme', 'كشاف عمليات', 'Surgical light'],
  ['bme', 'سرير كهربائي', 'Electric bed'],
  ['bme', 'جهاز قياس ضغط الدم', 'Blood pressure monitor'],
  ['bme', 'جهاز قياس الأكسجين', 'Pulse oximeter'],
  ['maint', 'مكيف هواء', 'Air conditioner'],
  ['maint', 'وحدة مناولة الهواء', 'Air handling unit'],
  ['maint', 'مولد كهربائي', 'Generator'],
  ['maint', 'مصعد', 'Elevator'],
  ['maint', 'مضخة مياه', 'Water pump'],
  ['maint', 'ثلاجة أدوية', 'Medication refrigerator'],
  ['maint', 'نظام إنذار الحريق', 'Fire alarm system'],
  ['it', 'جهاز كمبيوتر', 'Computer'],
  ['it', 'طابعة', 'Printer'],
  ['it', 'ماسح ضوئي', 'Scanner'],
  ['it', 'جهاز شبكة', 'Network switch'],
  ['it', 'هاتف شبكي', 'IP phone'],
];
export async function seedAssetTypes(env) {
  const now = nowIso();
  const [{ results: teams }, { results: types }] = await Promise.all([
    env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 1').all(),
    env.DB.prepare('SELECT name_ar, name_en FROM asset_types').all(),
  ]);
  const teamId = Object.fromEntries(STARTER_TEAMS.map(([key, ar, en]) => [key, (teams.find((d) => sameName(d, ar, en)) || {}).id]));
  const add = STARTER_ASSET_TYPES.filter(([key, ar, en]) => teamId[key] && !types.some((x) => sameName(x, ar, en))).map(([key, ar, en]) =>
    env.DB.prepare('INSERT INTO asset_types (name_ar, name_en, team_id, active, created_at) VALUES (?, ?, ?, 1, ?)').bind(ar, en, teamId[key], now),
  );
  await env.DB.batch([...add, setSettingStmt(env, 'asset_types_seeded', '1')]);
}

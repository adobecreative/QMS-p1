// End-to-end checks for Quality & Accreditation: CBAHI chapters, standards, self-assessment and readiness.
// Runs after systems.mjs, on the same data. Each check prints PASS or FAIL; any FAIL makes the run fail.

const B = process.env.BASE || 'http://localhost:8787';
let failed = 0;
const check = (cond, label, extra) => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300)));
};
const login = async (email, password) => {
  let cookie = '';
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(B + '/api' + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('fm_session=')) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const r = await api('/login', 'POST', { email, password });
  check(r.s === 200, 'sign in ' + email, r);
  return api;
};

const owner = await login('owner@example.com', 'secret-pass-1');
const tech = await login('tech@example.com', 'secret-pass-2');
let r;

// The chapters come ready, with their JCI match; ESR is a flag, not a chapter.
r = await owner('/quality');
check(r.s === 200 && r.j.chapters.length === 8 && r.j.chapters.find((c) => c.code === 'LD').jci === 'GLD', 'the CBAHI chapters are seeded with their JCI match', r.j);
check(r.j.total.n === 0 && r.j.total.pct === null && r.j.can_manage, 'no standards yet, no readiness yet', r.j.total);
check((await tech('/quality')).s === 403, 'someone without a quality role cannot open it');

// Accounts: a quality assessor of one department, and a viewer.
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
const [deptA, deptB] = depts;
check((await owner('/users', 'POST', { name: 'مقيم الجودة', name_en: 'Assessor', email: 'qa@example.com', role: 'user', password: 'secret-pass-3', quality_role: 'assessor', department_id: deptA.id })).s === 200, 'owner adds a quality assessor');
check((await owner('/users', 'POST', { name: 'مطلع الجودة', name_en: 'QA viewer', email: 'qv@example.com', role: 'user', password: 'secret-pass-3', quality_role: 'viewer' })).s === 200, 'owner adds a quality viewer');
const qa = await login('qa@example.com', 'secret-pass-3');
const qv = await login('qv@example.com', 'secret-pass-3');
r = await qa('/bootstrap');
check(r.j.user.quality === 'assessor' && r.j.user.quality_role === 'assessor', 'the assessor gets the quality role', r.j.user);

// Standards: one by one, and pasted from Excel.
r = await owner('/standards', 'POST', { code: 'LD.1', title_ar: 'خطة استراتيجية معتمدة', title_en: 'An approved strategic plan', jci: 'GLD.1', department_id: deptA.id });
check(r.s === 200, 'owner adds a standard', r);
const ld1 = r.j.id;
check((await owner('/standards', 'POST', { code: 'LD.1', title_ar: 'مكرر', title_en: 'Dup' })).s === 409, 'a code cannot be used twice');
check((await owner('/standards', 'POST', { code: 'ZZ.1', title_ar: 'فصل غير موجود', title_en: 'Unknown' })).s === 400, 'a code needs a known chapter');
check((await owner('/standards', 'POST', { code: 'LD.9', title_ar: 'Latin only', title_en: 'Latin' })).s === 400, 'the Arabic text must be Arabic');
check((await owner('/standards', 'POST', { code: 'LD.9', title_ar: 'نص', title_en: 'نص' })).s === 400, 'the English text cannot be Arabic');
check((await qa('/standards', 'POST', { code: 'LD.8', title_ar: 'نص', title_en: 'Text' })).s === 403, 'an assessor cannot add standards');
r = await owner('/standards/import', 'POST', {
  rows: [
    { code: 'IPC.1', title_ar: 'برنامج مكافحة العدوى', title_en: 'Infection control programme', esr: 1, jci: 'PCI.1' },
    { code: 'IPC.2', title_ar: 'نظافة الأيدي', title_en: 'Hand hygiene', esr: 1, jci: 'PCI.9' },
    { code: 'MM.1', title_ar: 'قائمة الأدوية المعتمدة', title_en: 'Approved formulary' },
    { code: 'MM.2', title_ar: 'تخزين الأدوية', title_en: 'Medication storage' },
    { code: 'XX.1', title_ar: 'خطأ', title_en: 'Bad' },
  ],
});
check(r.s === 200 && r.j.saved === 4 && r.j.errors.length === 1 && r.j.errors[0].error === 'std_bad_chapter', 'import saves good rows and reports the bad one', r.j);

// Self-assessment rules.
const list = (await owner('/standards')).j.standards;
const id = (code) => list.find((s) => s.code === code).id;
check((await owner('/standards/' + id('IPC.1') + '/score', 'PUT', { score: 'partial' })).s === 400, 'a gap needs a note');
check((await owner('/standards/' + id('IPC.1') + '/score', 'PUT', { score: 'maybe' })).s === 400, 'an unknown score is refused');
check((await qa('/standards/' + ld1 + '/score', 'PUT', { score: 'met', evidence: 'POL-LD-001' })).s === 200, "the assessor scores their department's standard");
check((await owner('/standards/' + ld1, 'PUT', { code: 'LD.1', title_ar: 'خطة استراتيجية معتمدة', title_en: 'An approved strategic plan', jci: 'GLD.1', department_id: deptB.id })).s === 200, 'owner moves the standard to another department');
check((await qa('/standards/' + ld1 + '/score', 'PUT', { score: 'met' })).s === 403, "the assessor cannot score another department's standard");
check((await qa('/standards/' + id('IPC.1') + '/score', 'PUT', { score: 'partial', note: 'لا يوجد تدريب سنوي' })).s === 200, 'the assessor scores a standard with no department');
check((await qv('/standards/' + id('IPC.2') + '/score', 'PUT', { score: 'met' })).s === 403, 'a viewer cannot score');
await owner('/standards/' + id('IPC.2') + '/score', 'PUT', { score: 'not_met', note: 'المعقمات غير متوفرة' });
await owner('/standards/' + id('MM.1') + '/score', 'PUT', { score: 'met' });
await owner('/standards/' + id('MM.2') + '/score', 'PUT', { score: 'na' });

// Readiness: met 1, partial half, not applicable left out, not assessed 0.
r = await qv('/quality');
const ch = (code) => r.j.chapters.find((c) => c.code === code).stats;
check(ch('IPC').pct === 25 && ch('IPC').esr_gap === 2, 'IPC readiness = (0.5 + 0) / 2 = 25%, two ESR gaps', ch('IPC'));
check(ch('MM').pct === 100 && ch('LD').pct === 100, 'not applicable is left out of the score', [ch('MM'), ch('LD')]);
check(r.j.esr.n === 2 && r.j.esr.pct === 25, 'the ESR line covers the ESR standards of every chapter', r.j.esr);
check(r.j.total.n === 5 && r.j.total.pct === 63 && r.j.total.open === 0, 'hospital readiness = 2.5 / 4 = 63%', r.j.total);
check(!r.j.can_manage && !r.j.can_assess, 'a viewer only reads');
r = await qv('/standards?chapter=ESR');
check(r.s === 200 && r.j.standards.length === 2 && r.j.standards.every((s) => s.esr === 1 && !s.can_score), 'ESR filter lists the ESR standards', r.j);
r = await qv('/home');
check(r.j.quality && r.j.quality.pct === 63 && r.j.quality.esr_gap === 2, 'the portal home shows readiness and ESR gaps', r.j.quality);

// Import again keeps the score; history keeps every assessment.
r = await owner('/standards/import', 'POST', { rows: [{ code: 'MM.1', title_ar: 'قائمة الأدوية المعتمدة (محدثة)', title_en: 'Approved formulary (updated)' }] });
const mm1 = (await owner('/standards?chapter=MM')).j.standards.find((s) => s.code === 'MM.1');
check(r.j.saved === 1 && mm1.score === 'met' && /محدثة/.test(mm1.title_ar), 're-import updates the text and keeps the score', mm1);
await owner('/standards/' + id('IPC.1') + '/score', 'PUT', { score: 'met', evidence: 'سجل التدريب 2026' });
r = await owner('/standards/' + id('IPC.1') + '/history');
check(r.s === 200 && r.j.history.length === 2 && r.j.history[0].score === 'met' && r.j.history[1].score === 'partial', 'history keeps every assessment, newest first', r.j);

// Delete: never assessed = gone; assessed = retired, history kept.
r = await owner('/standards', 'POST', { code: 'LD.2', title_ar: 'معيار تجريبي', title_en: 'Trial' });
check((await owner('/standards/' + r.j.id, 'DELETE')).j.retired === false, 'a standard never assessed is deleted');
check((await owner('/standards/' + id('IPC.2'), 'DELETE')).j.retired === true, 'an assessed standard is retired, not deleted');
r = await owner('/quality');
check(r.j.esr.n === 1 && r.j.chapters.find((c) => c.code === 'IPC').stats.n === 1, 'a retired standard leaves the readiness', r.j.esr);

// Chapters: rename, add one.
check((await owner('/std-chapters/NR', 'PUT', { name_ar: 'التمريض', name_en: 'Nursing', jci: 'COP, ASC' })).s === 200, 'owner edits a chapter');
check((await owner('/std-chapters', 'POST', { code: 'PC', name_ar: 'رعاية المرضى', name_en: 'Patient Care', jci: 'COP' })).s === 200, 'owner adds a chapter');
check((await owner('/std-chapters', 'POST', { code: 'PC', name_ar: 'مكرر', name_en: 'Dup' })).s === 409, 'a chapter code cannot be used twice');
check((await qa('/std-chapters/NR', 'PUT', { name_ar: 'س', name_en: 'S' })).s === 403, 'an assessor cannot change chapters');
r = await owner('/quality');
check(r.j.chapters.length === 9 && r.j.chapters.find((c) => c.code === 'NR').jci === 'COP, ASC', 'the chapters show the changes', r.j.chapters.map((c) => c.code));

// Activity log and backup.
r = await owner('/logs');
check(r.s === 200 && r.j.logs.some((l) => l.action === 'assess' && l.entity === 'standard'), 'assessments are in the activity log');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

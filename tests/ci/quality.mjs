import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  // A form upload (files), and a raw fetch to read a PDF.
  api.form = async (path, method, fd) => {
    const r = await fetch(B + '/api' + path, { method, headers: { cookie, 'x-requested-with': 'fetch' }, body: fd });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  api.raw = (path) => fetch(B + '/api' + path, { headers: { cookie, 'x-requested-with': 'fetch' } });
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

/* ---- the optional link to the Fikra portal (here the test site reads its own /api/v1) ---- */

const sup = await login('super@example.com', 'secret-pass-2');
r = await owner('/fms-link');
check(r.s === 200 && r.j.on === false && !r.j.key_set, 'the link is off by default');
check((await qv('/quality')).j.fms === null, 'with the link off, no FMS evidence is shown');
check((await sup('/fms-link')).s === 403, 'only the system owner sets the link');
check((await owner('/fms-link', 'PUT', { on: true, url: 'ftp://x', key: '' })).s === 400, 'a bad address is refused');
check((await owner('/fms-link', 'PUT', { on: true, url: B })).s === 400, 'switching on needs a key');
check((await owner('/fms-link', 'PUT', { on: true, url: B, key: 'abc' })).s === 400, 'a key in the wrong form is refused');
r = await owner('/api-keys', 'POST', { name_ar: 'ربط الجودة', name_en: 'QMS link', scopes: ['tickets_read', 'assets_read'] });
check(r.s === 200 && /^fms_/.test(r.j.key), 'owner makes a read-only key', r);
const linkKey = r.j.key;
{
  const sum = await fetch(B + '/api/v1/summary', { headers: { authorization: 'Bearer ' + linkKey } }).then(async (x) => ({ s: x.status, j: await x.json() }));
  check(sum.s === 200 && sum.j.system === 'quality' && sum.j.icon === 'award' && sum.j.stats.length === 2 && sum.j.stats[0].ar === 'جاهزية', 'the portal card reads readiness and corrective actions', sum);
}
r = await owner('/fms-link', 'PUT', { on: true, url: B + '/', key: linkKey });
check(r.s === 200 && r.j.on && r.j.key_set && r.j.sync && r.j.sync.ok && !('key' in r.j) && !JSON.stringify(r.j).includes(linkKey), 'switching on reads at once, and the key never comes back', r.j);
check(r.j.snapshot && r.j.snapshot.tickets && r.j.snapshot.tickets.open >= 1 && r.j.snapshot.assets && typeof r.j.snapshot.assets.total === 'number', 'the summary has requests and devices', r.j.snapshot);
r = await qv('/quality');
check(r.j.fms && r.j.fms.snapshot && r.j.fms.error === null && r.j.fms.synced_at, 'a quality viewer sees the FMS evidence', r.j.fms);
check((await qv('/bootstrap')).j.portal_url === B, 'the systems button goes back to the portal');
// A key switched off in the portal: the error shows, the last summary stays.
const keys = (await owner('/api-keys')).j.keys;
const k = keys.find((x) => x.name_en === 'QMS link');
await owner('/api-keys/' + k.id, 'PUT', { name_ar: k.name_ar, name_en: k.name_en, scopes: k.scopes, active: false });
r = await owner('/fms-link/sync', 'POST');
check(r.s === 200 && r.j.ok === false && r.j.error === 'link_bad_key', 'a refused key is reported', r.j);
r = await qv('/quality');
check(r.j.fms.error === 'link_bad_key' && r.j.fms.snapshot && r.j.fms.snapshot.tickets, 'the last good summary stays on screen with the error', r.j.fms);
check((await qv('/fms-link/sync', 'POST')).s === 403, 'a viewer cannot run the sync');
r = await owner('/backup');
if (r.s === 200) check(!JSON.stringify(r.j).includes(linkKey) && !('link_key' in ((r.j.data || r.j).settings || {})), 'the backup never holds the link key');
r = await owner('/fms-link', 'PUT', { on: false });
check(r.s === 200 && !r.j.on && !r.j.key_set && r.j.snapshot === null, 'switching off forgets the key and the summary', r.j);
check((await qv('/quality')).j.fms === null, 'and the evidence leaves the FMS chapter');
check((await qv('/bootstrap')).j.portal_url === '', 'and the systems button stays in this system');

// Chapter files: a documents file filed under a CBAHI chapter shows on that chapter's page.
{
  r = await owner('/doc-types');
  check(r.s === 200 && r.j.chapters.some((c) => c.code === 'FMS'), 'the file form lists the chapters', r.j && r.j.chapters);
  const type = r.j.doc_types[0].key;
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const fileForm = (extra) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: 'خطة السلامة من الحريق', name_en: 'Fire safety plan', file_number: 'FMS-PL-01', doc_type: type, department_id: deptA.id, ...extra })) fd.set(k, String(v));
    fd.set('pdf', new Blob([pdfBytes], { type: 'application/pdf' }), 'fire.pdf');
    return fd;
  };
  check((await owner.form('/files', 'POST', fileForm({ chapter: 'ZZZ' }))).s === 400, 'an unknown chapter is refused');
  r = await owner.form('/files', 'POST', fileForm({ chapter: 'fms' }));
  check(r.s === 200 && r.j.id, 'a file is added under the FMS chapter', r);
  const fileId = r.j.id;
  r = await qv('/quality/files?chapter=FMS');
  const got = r.j && r.j.files.find((f) => f.id === fileId);
  check(r.s === 200 && got && got.chapter === 'FMS' && got.pdf_url && r.j.can_add === false, 'a quality viewer sees the chapter files, read only', r.j);
  check((await owner('/quality/files?chapter=FMS')).j.can_add === true, 'a documents admin can add files there');
  check((await qv('/quality/files?chapter=LD')).j.files.length === 0, 'other chapters do not show it');
  const pdf = await qv.raw('/quality/files/' + fileId + '/pdf');
  check(pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf', 'a quality viewer opens the PDF', pdf.status);
  check((await tech('/quality/files?chapter=FMS')).s === 403, 'someone without a quality role cannot list chapter files');
  r = await owner('/quality');
  check(r.j.chapters.find((c) => c.code === 'FMS').files >= 1, 'the chapter card counts its files', r.j.chapters.find((c) => c.code === 'FMS'));
  r = await owner('/files');
  check(r.j.files.find((f) => f.id === fileId).chapter === 'FMS', 'the documents list carries the chapter');
  r = await owner.form('/files/' + fileId, 'PUT', fileForm({ chapter: '' }));
  check(r.s === 200, 'the chapter can be taken off', r);
  check((await qv.raw('/quality/files/' + fileId + '/pdf')).status === 404, 'a file without a chapter is not open to quality users');
  r = await owner('/logs');
  check(r.j.logs.some((l) => l.entity === 'file' && l.details && l.details.includes('"chapter"')), 'the chapter change is in the activity log');
}

// The portal's documents and staff over the link (the test site reads its own /api/v1 again).
{
  r = await owner('/api-keys', 'POST', { name_ar: 'وثائق الجودة', name_en: 'QMS docs', scopes: ['docs_read', 'staff'] });
  const docsKey = r.j.key;
  check((await owner('/staff')).s === 200, 'the staff list opens');
  r = await owner('/fms-link', 'PUT', { on: true, url: B, key: docsKey });
  check(r.s === 200 && r.j.sync && r.j.sync.ok && r.j.snapshot.docs && r.j.snapshot.docs.total >= 1 && r.j.snapshot.staff && r.j.snapshot.scopes.includes('docs_read'), 'the link reads the documents and the staff', r.j);
  check((await owner('/bootstrap')).j.user.portal_docs === true, 'the menu knows portal documents are on');
  r = await qv('/portal-docs');
  const fire = r.j && r.j.docs.find((x) => x.file_number === 'FMS-PL-01');
  check(r.s === 200 && r.j.on && fire && fire.has_pdf && fire.chapter === null && r.j.can_file === false, 'a quality viewer sees the portal documents, read only', r.j);
  check((await tech('/portal-docs')).s === 403, 'someone without a documents or quality role cannot see them');
  check((await qv('/portal-docs/' + fire.id, 'PUT', { chapter: 'FMS' })).s === 403, 'a viewer cannot file a document');
  check((await owner('/portal-docs/' + fire.id, 'PUT', { chapter: 'ZZZ' })).s === 400, 'an unknown chapter is refused');
  check((await owner('/portal-docs/' + fire.id, 'PUT', { chapter: 'ld' })).s === 200, 'a manager files a portal document under a chapter');
  r = await qv('/quality/files?chapter=LD');
  const tile = r.j.files.find((x) => x.portal);
  check(tile && tile.file_number === 'FMS-PL-01' && tile.pdf_url === '/api/portal-docs/' + fire.id + '/pdf', 'it shows with the chapter files', r.j.files);
  check((await owner('/quality')).j.chapters.find((c) => c.code === 'LD').files >= 1, 'the chapter card counts it');
  check((await owner('/quality/files?chapter=LD')).j.can_add === false, 'with portal documents on, nothing is added to a chapter here');
  r = await owner('/home');
  check(r.j.docs && r.j.docs.total >= 1, 'the home page counts the portal documents', r.j.docs);
  const pdf = await qv.raw('/portal-docs/' + fire.id + '/pdf');
  check(pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf' && (await pdf.text()).startsWith('%PDF-'), 'its PDF opens through this server');
  check((await qv.raw('/portal-docs/999999/pdf')).status === 404, 'an unknown document is 404');
  // A second sync keeps the chapter.
  check((await owner('/fms-link/sync', 'POST')).j.ok, 'a second read works');
  check((await owner('/portal-docs')).j.docs.find((x) => x.id === fire.id).chapter === 'LD', 'and keeps the chapter');
  r = await owner('/backup');
  if (r.s === 200) check(((r.j.data || r.j).portal_docs || []).some((x) => x.chapter === 'LD'), 'the backup keeps the filing');
  r = await owner('/fms-link', 'PUT', { on: false });
  check(r.s === 200 && (await owner('/portal-docs')).j.docs.length === 0, 'switching the link off removes the portal documents');
  check((await qv('/quality/files?chapter=LD')).j.files.every((x) => !x.portal), 'and they leave the chapter');
}

// Frameworks: a JCI pack beside CBAHI. FMS is a chapter in both, kept apart by framework. The texts here are
// made up: real packs are built from the hospital's licensed copy and never kept in this repository.
{
  const jciPack = {
    framework: 'jci',
    edition: 'test',
    first: true,
    chapters: [
      { code: 'FMS', name_ar: 'إدارة المرافق والسلامة', name_en: 'Facility Management and Safety', sort: 1 },
      { code: 'IPSG', name_ar: '', name_en: 'Patient Safety Goals', sort: 2 },
    ],
    standards: [
      { code: 'FMS.01.00', title_en: 'Test standard one.', elements: [{ num: '1', text: 'First element.', doc: 1 }, { num: '2', text: 'Second element.', is_new: 1 }] },
      { code: 'IPSG.01.00', title_en: 'Test standard two.', elements: [{ num: '1', text: 'Only element.' }] },
      { code: 'ZZZ.01.00', title_en: 'Unknown chapter.' },
    ],
  };
  check((await qa('/standards/pack', 'POST', jciPack)).s === 403, 'an assessor cannot import a pack');
  check((await owner('/standards/pack', 'POST', { ...jciPack, framework: 'xyz' })).s === 400, 'an unknown framework is refused');
  r = await owner('/standards/pack', 'POST', jciPack);
  check(r.s === 200 && r.j.saved === 2 && r.j.errors.length === 1 && r.j.errors[0].error === 'std_bad_chapter', 'a JCI pack part saves its standards and reports the bad one', r.j);
  r = await owner('/quality?framework=jci');
  check(r.s === 200 && r.j.framework === 'jci' && r.j.chapters.length === 2 && r.j.total.n === 2 && r.j.has_esr === false, 'the JCI chapters stand on their own', r.j);
  check(r.j.frameworks.find((f) => f.key === 'jci').on === true && r.j.frameworks[0].key === 'cbahi', 'the import turned JCI on, after CBAHI', r.j.frameworks);
  check(r.j.chapters.find((c) => c.code === 'IPSG').name_ar === '', 'a chapter with no Arabic name keeps it empty until edited');
  r = await owner('/quality');
  check(r.j.framework === 'cbahi' && !r.j.chapters.some((c) => c.code === 'IPSG') && r.j.chapters.find((c) => c.code === 'FMS').jci === 'FMS', 'CBAHI is unchanged, its FMS chapter too', r.j.chapters.map((c) => c.code));
  r = await qv('/standards?framework=jci&chapter=FMS');
  const fms1 = r.j.standards[0];
  check(r.s === 200 && r.j.standards.length === 1 && fms1.framework === 'jci' && fms1.elements.length === 2 && fms1.elements[0].doc === 1 && fms1.elements[1].is_new === 1 && fms1.title_ar === '', 'JCI standards come with their MEs, D and New flags', fms1);
  check((await owner('/standards?framework=cbahi&chapter=FMS')).j.standards.every((x) => x.framework === 'cbahi'), 'the CBAHI FMS list does not mix in JCI');
  // The same code may exist in another framework.
  check((await owner('/standards', 'POST', { framework: 'cbahi', code: 'FMS.01.00', title_ar: 'معيار سباهي بنفس الرمز', title_en: 'Same code in CBAHI' })).s === 200, 'a CBAHI standard can share a code with JCI');

  // Scoring element by element: every ME needs a score, the standard's score is worked out.
  const [e1, e2] = fms1.elements;
  check((await qa('/standards/' + fms1.id + '/score', 'PUT', { elements: [{ id: e1.id, score: 'met' }] })).j.error === 'std_elements_open', 'every element needs a score');
  check((await qa('/standards/' + fms1.id + '/score', 'PUT', { elements: [{ id: e1.id, score: 'met' }, { id: e2.id, score: 'partial' }] })).j.error === 'std_gap_note', 'a mixed result needs a note');
  r = await qa('/standards/' + fms1.id + '/score', 'PUT', { elements: [{ id: e1.id, score: 'met' }, { id: e2.id, score: 'partial', note: 'Policy not approved yet' }], note: 'One ME still partial' });
  check(r.s === 200 && r.j.score === 'partial', 'met + partial makes the standard partly met', r.j);
  r = await owner('/standards?framework=jci&chapter=FMS');
  check(r.j.standards[0].score === 'partial' && r.j.standards[0].elements[1].note === 'Policy not approved yet', 'the scores and notes are saved', r.j.standards[0]);
  r = await qa('/standards/' + fms1.id + '/score', 'PUT', { elements: [{ id: e1.id, score: 'na' }, { id: e2.id, score: 'met' }] });
  check(r.j.score === 'met', 'n/a is left out: met + n/a is met', r.j);
  r = await owner('/standards/' + fms1.id + '/history');
  check(r.j.history.length === 2 && r.j.history.every((x) => x.score), 'the history shows the standard, not each element', r.j.history);

  // Sending the pack again updates texts and keeps scores; an element the new text dropped goes if unscored.
  r = await owner('/standards/pack', 'POST', { framework: 'jci', standards: [{ code: 'FMS.01.00', title_en: 'Test standard one, revised.', elements: [{ num: '1', text: 'First element, revised.' }, { num: '2', text: 'Second element.' }] }, { code: 'IPSG.01.00', title_en: 'Test standard two.', elements: [{ num: '2', text: 'Replaced element.' }] }], last: true });
  check(r.s === 200 && r.j.saved === 2, 'a second part is imported', r.j);
  r = await owner('/standards?framework=jci');
  const again = r.j.standards.find((x) => x.code === 'FMS.01.00');
  const ipsg = r.j.standards.find((x) => x.code === 'IPSG.01.00');
  check(again.score === 'met' && again.elements[0].text === 'First element, revised.' && again.elements[0].score === 'na' && /revised/.test(again.title_en), 're-import updates the texts and keeps the scores', again);
  check(ipsg.elements.length === 1 && ipsg.elements[0].num === '2', 'an unscored element no longer in the pack is removed', ipsg.elements);

  // CBAHI: an ESR is all or nothing, so a partly met sub-standard makes it not met.
  r = await owner('/standards/pack', 'POST', { framework: 'cbahi', standards: [{ code: 'IPC.9', title_en: 'Test ESR.', esr: 1, elements: [{ num: '1', text: 'Sub one.' }, { num: '2', text: 'Sub two.' }] }] });
  check(r.s === 200 && r.j.saved === 1, 'a CBAHI pack part with an ESR', r.j);
  const esr9 = (await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.9');
  r = await owner('/standards/' + esr9.id + '/score', 'PUT', { elements: esr9.elements.map((e, i) => ({ id: e.id, score: i ? 'partial' : 'met' })), note: 'Gap' });
  check(r.j.score === 'not_met', 'an ESR partly met counts as not met', r.j);
  // An imported standard can be edited before it has its Arabic wording.
  check((await owner('/standards/' + esr9.id, 'PUT', { code: 'IPC.9', title_ar: '', title_en: 'Test ESR.', esr: 1 })).s === 200, 'an imported standard can be edited without Arabic yet');

  // The chapter scoring page: each sub-standard scored by activity, saved one element at a time.
  r = await owner('/standards/pack', 'POST', { framework: 'cbahi', standards: [{ code: 'IPC.10', title_en: 'Test activities.', elements: [{ num: '1', text: 'A policy on gases, which includes:\n• Storage.\n• Chains.' }, { num: '2', text: 'Exhausts reach the roof.' }] }] });
  let s10 = (await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.10');
  const [a1, a2] = s10.elements;
  check(Array.isArray(a1.activities) && a1.activities.length === 0, 'a new sub-standard has no activities yet', a1);
  const elUrl = (e) => '/standards/' + s10.id + '/elements/' + e.id;
  check((await qv(elUrl(a1), 'PUT', { activities: [{ kind: 'document', score: 'met' }] })).s === 403, 'a viewer cannot score an activity');
  check((await qa(elUrl(a1), 'PUT', { activities: [] })).j.error === 'std_no_activity', 'an element keeps at least one activity');
  check((await qa(elUrl(a1), 'PUT', { activities: [{ kind: 'tour', score: 'met' }] })).j.error === 'std_bad_activity', 'an unknown activity is refused');
  check((await qa(elUrl(a1), 'PUT', { activities: [{ kind: 'document', score: '3' }] })).j.error === 'std_bad_score', 'an unknown activity score is refused');
  r = await qa(elUrl(a1), 'PUT', { activities: [{ kind: 'document', score: 'met' }, { kind: 'observation', score: null }] });
  check(r.s === 200 && r.j.activities.every((x) => x.id) && r.j.element.score === null && r.j.score === null, 'an open activity leaves the element and the standard open', r.j);
  const [d1, o1] = r.j.activities;
  r = await qa(elUrl(a1), 'PUT', { activities: [{ id: d1.id, kind: 'document', score: 'met' }, { id: o1.id, kind: 'observation', score: 'not_met' }] });
  check(r.j.element.score === 'partial' && r.j.score === null, 'a met policy and a failed observation make the sub-standard partly met', r.j);
  r = await qa(elUrl(a2), 'PUT', { activities: [{ kind: 'observation', score: 'met' }] });
  check(r.j.element.score === 'met' && r.j.score === 'partial', 'the standard is worked out once every sub-standard is scored', r.j);
  s10 = (await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.10');
  check(s10.score === 'partial' && s10.elements[0].activities.length === 2 && s10.elements[0].activities[1].kind === 'observation' && s10.elements[0].activities[1].score === 'not_met', 'the activities come back with the standards', s10.elements[0]);
  r = await qa(elUrl(a1), 'PUT', { activities: [{ id: o1.id, kind: 'observation', score: 'met', note: 'Chains fixed' }] });
  check(r.j.activities.length === 1 && r.j.activities[0].id === o1.id && r.j.element.score === 'met' && r.j.element.note === 'Chains fixed' && r.j.score === 'met', 'an activity left out is removed and the scores follow', r.j);
  check((await qa('/standards/' + s10.id + '/elements/' + esr9.elements[0].id, 'PUT', { activities: [{ kind: 'document', score: 'met' }] })).s === 404, 'an element of another standard is refused');
  check((await qa(elUrl(a2), 'PUT', { activities: [{ id: d1.id, kind: 'document', score: 'met' }] })).s === 404, "another element's activity is refused");
  r = await qa(elUrl(a2), 'PUT', { activities: [{ kind: 'observation', score: null }] });
  check(r.j.element.score === null && r.j.score === null, 'clearing a score opens the standard again', r.j);
  r = await owner('/standards/' + s10.id + '/history');
  check(r.j.history.length >= 2 && r.j.history[0].score === 'met', "the standard's history keeps its worked-out scores", r.j.history);

  // Sub-standards typed in by a manager, in the standard's dialog.
  const base10 = { code: 'IPC.10', title_ar: '', title_en: 'Test activities.' };
  const cur = (await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.10');
  const keepEls = cur.elements.map((e) => ({ id: e.id, num: e.num, text: e.text }));
  check((await qa('/standards/' + s10.id, 'PUT', { ...base10, elements: keepEls })).s === 403, 'an assessor cannot change sub-standards');
  check((await owner('/standards/' + s10.id, 'PUT', { ...base10, elements: [...keepEls, { num: '2', text: 'Twice.' }] })).j.error === 'std_el_num_taken', 'a sub-standard number is used once');
  check((await owner('/standards/' + s10.id, 'PUT', { ...base10, elements: [...keepEls, { num: '3', text: '' }] })).j.error === 'std_bad_element', 'a sub-standard needs a text');
  check((await owner('/standards/' + s10.id, 'PUT', { ...base10, elements: keepEls.slice(1) })).j.error === 'std_el_scored', 'a scored sub-standard cannot be removed');
  r = await owner('/standards/' + s10.id, 'PUT', { ...base10, elements: [...keepEls, { num: '3', text: 'سياسة مكتوبة للغازات.' }] });
  check(r.s === 200, 'a manager adds a sub-standard in Arabic', r.j);
  let s10b = (await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.10');
  check(s10b.elements.length === 3 && s10b.elements[2].num === '3' && s10b.elements[0].activities.length === 1, 'the new sub-standard is added and the scores stay', s10b.elements);
  r = await owner('/standards/' + s10.id, 'PUT', { ...base10, elements: [{ ...keepEls[0], num: '2' }, { ...keepEls[1], num: '1' }, { id: s10b.elements[2].id, num: '3', text: 'Edited.' }] });
  check(r.s === 200, 'two sub-standards can swap numbers', r.j);
  s10b = (await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.10');
  check(s10b.elements.find((e) => e.id === keepEls[0].id).num === '2' && s10b.elements[2].text === 'Edited.', 'the numbers and texts are saved', s10b.elements);
  r = await owner('/standards/' + s10.id, 'PUT', { ...base10, elements: s10b.elements.slice(0, 2).map((e) => ({ id: e.id, num: e.num, text: e.text })) });
  check(r.s === 200, 'an unscored sub-standard can be removed', r.j);
  r = await owner('/standards', 'POST', { framework: 'cbahi', code: 'IPC.11', title_ar: 'معيار جديد', title_en: 'A new standard', elements: [{ num: '1', text: 'First.' }, { num: '2', text: 'Second.' }] });
  check(r.s === 200, 'a new standard comes with its sub-standards', r.j);
  check((await owner('/standards?chapter=IPC')).j.standards.find((x) => x.code === 'IPC.11').elements.length === 2, 'they are saved with it');

  // Which frameworks show.
  check((await qa('/quality/frameworks', 'PUT', { on: ['jci'] })).s === 403, 'an assessor cannot change the frameworks');
  check((await owner('/quality/frameworks', 'PUT', { on: [] })).s === 400, 'at least one framework stays on');
  r = await owner('/quality/frameworks', 'PUT', { on: ['jci', 'cbahi'] });
  check(r.s === 200, 'owner puts JCI first', r.j);
  r = await owner('/quality');
  check(r.j.framework === 'jci', 'the first framework opens by default', r.j.framework);
  await owner('/quality/frameworks', 'PUT', { on: ['cbahi', 'jci'] });
  // A chapter in JCI is edited through its framework.
  check((await owner('/std-chapters/IPSG?framework=jci', 'PUT', { name_ar: 'أهداف سلامة المرضى', name_en: 'Patient Safety Goals' })).s === 200, 'a JCI chapter gets its Arabic name');
  check((await owner('/std-chapters/IPSG', 'PUT', { name_ar: 'أهداف', name_en: 'Goals' })).s === 404, 'without the framework it is looked for in CBAHI');
}

// Quality rounds: a checklist in a chapter, lines with their standard, no maintenance request. Failed lines
// open corrective actions; the CAPA register works them through to verified.
{
  const loc = await owner('/locations', 'POST', { name_ar: 'غرفة المولد', name_en: 'Generator room', department_id: deptA.id });
  check(loc.s === 200, 'owner adds a place for the quality round', loc.j);
  r = await owner('/round-forms', 'POST', {
    name_ar: 'جولة سلامة المرافق', name_en: 'Facility safety round', every_days: 30, chapter: 'FMS', location_ids: [loc.j.id],
    items: [{ text_ar: 'مخارج الطوارئ مفتوحة', text_en: 'Exits clear', std_code: 'fms.3.1' }, { text_ar: 'الطفايات صالحة', std_code: 'FMS.4' }, { text_ar: 'الإضاءة تعمل' }],
  });
  check(r.s === 200, 'a quality checklist needs no problem type', r.j);
  const formId = r.j.id;
  check((await owner('/round-forms', 'POST', { name_ar: 'س', name_en: 'X', every_days: 7, chapter: 'NOPE', location_ids: [loc.j.id], items: [{ text_ar: 'بند' }] })).s === 400, 'an unknown chapter is refused');
  check((await owner('/round-forms', 'POST', { name_ar: 'س', name_en: 'X', every_days: 7, location_ids: [loc.j.id], items: [{ text_ar: 'بند', std_code: 'بند' }] })).s === 400, 'a bad standard code is refused');
  const fm = (await owner('/round-forms/' + formId)).j;
  check(fm.form.chapter === 'FMS' && fm.items[0].std_code === 'FMS.3.1', 'the chapter and the line standards are kept', fm);
  const place = (await owner('/rounds')).j.places.find((x) => x.form_id === formId);
  const st = (await owner('/rounds/start/' + place.id)).j;
  const [i1, i2, i3] = st.items;
  r = await owner('/rounds', 'POST', { place_id: place.id, answers: [{ item_id: i1.id, result: 'fail', note: 'مخرج مغلق بصناديق' }, { item_id: i2.id, result: 'fail' }, { item_id: i3.id, result: 'ok' }] });
  check(r.s === 200 && r.j.ticket_id === null && r.j.capa_n === 2, 'two failed lines open two corrective actions and no request', r.j);
  const roundId = r.j.id;
  const det = (await owner('/rounds/' + roundId)).j;
  check(det.capa.length === 2 && det.answers[0].std_code === 'FMS.3.1', 'the round shows its corrective actions', det);
  const log = (await owner('/rounds/log')).j.rounds.find((x) => x.id === roundId);
  check(log.capa_n === 2 && log.capa_open === 2, 'the log counts them', log);

  r = await owner('/capa');
  const mine = r.j.capa.filter((c) => c.round_id === roundId);
  check(r.s === 200 && mine.length === 2 && r.j.can_verify, 'the register lists them', r.j);
  const c1 = mine.find((c) => c.std_code === 'FMS.3.1');
  check(c1 && c1.chapter === 'FMS' && c1.source === 'round' && c1.status === 'open' && c1.detail === 'مخرج مغلق بصناديق' && c1.loc_en === 'Generator room' && c1.due > st.today, 'an action carries the line, the standard, the place and a due date', c1);

  check((await qv('/capa')).s === 200, 'a quality viewer reads the register');
  check((await qv('/capa/' + c1.id, 'PUT', { status: 'doing' })).s === 403, 'a viewer cannot change an action');
  check((await tech('/capa')).s === 403, 'no quality role, no register');
  check((await qa('/capa/' + c1.id, 'PUT', { status: 'done' })).s === 400, 'closing needs the action taken');
  r = await qa('/capa/' + c1.id, 'PUT', { owner: 'مشرف السلامة', cause: 'تخزين خاطئ', action: 'نقل الصناديق وتعليم المخرج', status: 'done' });
  check(r.s === 200, 'the assessor closes it with the action', r.j);
  check((await qa('/capa/' + c1.id, 'PUT', { status: 'verified' })).s === 403, 'only a quality manager verifies');
  r = await owner('/capa/' + c1.id, 'PUT', { status: 'verified' });
  check(r.s === 200, 'the manager verifies it', r.j);
  r = (await owner('/capa/' + c1.id)).j.capa;
  check(r.status === 'verified' && r.done_by && r.verified_by && r.owner === 'مشرف السلامة', 'who did and who checked are kept', r);
  check((await qa('/capa/' + c1.id, 'PUT', { status: 'open' })).s === 403, 'an assessor cannot reopen a verified action');

  r = await qa('/capa', 'POST', { title: 'تحديث خطة الإخلاء', chapter: 'FMS', std_code: 'FMS.2' });
  check(r.s === 200, 'an assessor adds an action by hand', r.j);
  const manual = r.j.id;
  check((await qa('/capa', 'POST', { title: 'x', status: 'nope' })).s === 400, 'an unknown status is refused');
  r = await owner('/home');
  check(r.j.quality && r.j.quality.capa_open >= 2, 'the home page counts open actions', r.j.quality);
  check((await qa('/capa/' + manual, 'DELETE')).s === 403, 'only a manager deletes');
  check((await owner('/capa/' + manual, 'DELETE')).s === 200, 'the manager deletes it');
}

// Quality indicators: from the library, entered by period, worked out from the system; the readiness report.
{
  r = await owner('/kpis');
  check(r.s === 200 && r.j.kpis.length === 0 && r.j.library.length >= 10 && r.j.can_manage, 'the indicator library is offered', r.j);
  check((await tech('/kpis')).s === 403, 'no quality role, no indicators');
  check((await qa('/kpis/library', 'POST', { codes: ['IPC-HH'] })).s === 403, 'only a quality manager adds indicators');
  r = await owner('/kpis/library', 'POST', { codes: ['IPC-HH', 'QM-ROUNDS', 'QM-CAPA', 'NR-FALL'] });
  check(r.s === 200 && r.j.added === 4, 'four indicators come from the library', r.j);
  r = await owner('/kpis');
  const hh = r.j.kpis.find((k) => k.code === 'IPC-HH');
  const rounds = r.j.kpis.find((k) => k.code === 'QM-ROUNDS');
  const fall = r.j.kpis.find((k) => k.code === 'NR-FALL');
  check(hh && hh.unit === 'pct' && hh.target === 90 && hh.chapter === 'IPC' && hh.can_enter, 'an indicator carries its unit, target and chapter', hh);
  check(rounds && rounds.source === 'rounds' && rounds.values.some((v) => v.period === rounds.current && v.den >= 1 && v.entered_by === 'system'), 'rounds on time is worked out from the rounds done', rounds);
  check(!rounds.can_enter && (await owner('/kpis/' + rounds.id + '/values', 'PUT', { period: rounds.current, num: 1, den: 1 })).s === 400, 'an automatic indicator takes no typed numbers');
  const [y, m] = hh.current.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  check((await owner('/kpis/' + hh.id + '/values', 'PUT', { period: next, num: 1, den: 2 })).s === 400, 'a future period is refused');
  check((await owner('/kpis/' + hh.id + '/values', 'PUT', { period: prev, num: 60, den: 50 })).s === 400, 'a percentage numerator cannot pass the denominator');
  check((await qv('/kpis/' + hh.id + '/values', 'PUT', { period: prev, num: 45, den: 50 })).s === 403, 'a viewer cannot enter numbers');
  r = await qa('/kpis/' + hh.id + '/values', 'PUT', { period: prev, num: 45, den: 50, note: 'رصد شهري' });
  check(r.s === 200 && r.j.value === 90 && r.j.met === true, 'the assessor enters a month: 45 of 50 is 90%, met', r.j);
  r = await owner('/kpis/' + fall.id + '/values', 'PUT', { period: prev, num: 3, den: 1500 });
  check(r.s === 200 && r.j.value === 2 && r.j.met === false, 'falls per 1000 days: 2 is above the target of 1, below target', r.j);
  check((await owner('/kpis', 'POST', { code: 'IPC-HH', name_ar: 'مكرر', name_en: 'Dup' })).s === 409, 'a code is used once');
  check((await owner('/kpis', 'POST', { code: 'رمز', name_ar: 'س', name_en: 'X' })).s === 400, 'a code is English letters and numbers');
  r = await owner('/kpis', 'POST', { code: 'ER-WAIT', name_ar: 'متوسط الانتظار في الطوارئ', name_en: 'ER waiting time', unit: 'value', direction: 'down', target: 30, frequency: 'quarterly' });
  check(r.s === 200, 'a quarterly indicator of plain numbers is added', r.j);
  const er = r.j.id;
  const q = (await owner('/kpis')).j.kpis.find((k) => k.id === er);
  check(/^\d{4}-Q[1-4]$/.test(q.current), 'its period is a quarter', q.current);
  r = await owner('/kpis/' + er + '/values', 'PUT', { period: q.current, num: 25 });
  check(r.s === 200 && r.j.value === 25 && r.j.met === true, 'a plain number needs no denominator', r.j);
  check((await owner('/kpis/' + er, 'DELETE')).s === 200, 'an indicator is deleted with its values');

  r = await owner('/readiness');
  check(r.s === 200 && r.j.framework === 'cbahi' && r.j.total.n > 0 && Array.isArray(r.j.gaps) && r.j.trend.length >= 1 && r.j.chapters.length > 0, 'the readiness report has totals, chapters, gaps and this month in the trend', r.j);
  check((await qv('/readiness')).s === 200 && (await tech('/readiness')).s === 403, 'quality staff read the readiness report');
  r = await owner('/backup');
  if (r.s === 200) check(((r.j.data || r.j).kpis || []).length >= 4 && ((r.j.data || r.j).kpi_values || []).length >= 2, 'the backup keeps the indicators and their values');
}

// Activity log and backup.
r = await owner('/logs');
check(r.s === 200 && r.j.logs.some((l) => l.action === 'assess' && l.entity === 'standard'), 'assessments are in the activity log');

// Accounts kept in step with the portal's (users permission): a small stand-in portal on another port.
{
  const { createServer } = await import('node:http');
  const KEY = 'fms_' + 'a'.repeat(40);
  const people = [
    { id: 101, name_ar: 'مقيم الجودة', name_en: 'Assessor', email: 'qa@example.com', active: true, department: { id: 1, name_ar: 'الجودة', name_en: 'Quality' } },
    { id: 102, name_ar: 'موظف جديد', name_en: 'Newcomer', email: 'new@example.com', active: true, department: null },
    { id: 103, name_ar: 'مطلع الجودة', name_en: 'QA viewer', email: 'qv@example.com', active: true, department: null },
    { id: 104, name_ar: 'المالك', name_en: 'Owner', email: 'owner@example.com', active: true, department: null },
  ];
  const srv = createServer((req, res) => {
    const send = (code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    if (req.headers.authorization !== 'Bearer ' + KEY) return send(401, { error: 'api_key_invalid' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/v1/ping') return send(200, { ok: true, scopes: ['users_read'] });
    if (u.pathname === '/api/v1/users') {
      const after = Number(u.searchParams.get('after_id')) || 0;
      const limit = Number(u.searchParams.get('limit')) || 100;
      const rows = people.filter((p) => p.id > after);
      return send(200, { users: rows.slice(0, limit), more: rows.length > limit });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((ok) => srv.listen(8799, ok));
  const P = 'http://localhost:8799';
  r = await owner('/fms-link', 'PUT', { on: true, url: P, key: KEY });
  check(r.s === 200 && r.j.sync && r.j.sync.ok && r.j.snapshot.users && r.j.snapshot.users.linked === 3 && r.j.snapshot.users.missing === 1, 'the first read links the accounts with the same email', r.j);
  let users = (await owner('/users')).j.users;
  const qaU = users.find((u) => u.email === 'qa@example.com');
  check(qaU.portal === true && qaU.portal_off === false, 'a linked account is marked', qaU);
  check(!users.find((u) => u.email === 'tech@example.com').portal, 'an account with no portal match stays as it is');
  r = await owner('/portal-users');
  check(r.s === 200 && r.j.on && r.j.users.length === 1 && r.j.users[0].email === 'new@example.com' && !('password' in r.j.users[0]), 'the admin sees who has no account here', r.j);
  check((await qv('/portal-users')).s === 403, 'a non-admin cannot see the portal list');
  r = await owner('/users', 'POST', { name: 'موظف جديد', name_en: 'Newcomer', email: 'new@example.com', role: 'user', password: 'secret-pass-4', quality_role: 'viewer', portal_id: 102 });
  check(r.s === 200, 'the admin adds someone from the list, linked from the start', r);
  check((await owner('/portal-users')).j.users.length === 0, 'and they leave the list');
  check((await owner('/users', 'POST', { name: 'نسخة', name_en: 'Copy', email: 'copy@example.com', role: 'user', password: 'secret-pass-4', portal_id: 102 })).s === 409, 'a portal account links to one account only');
  check((await owner('/users', 'POST', { name: 'مجهول', name_en: 'Nobody', email: 'nobody@example.com', role: 'user', password: 'secret-pass-4', portal_id: 999 })).s === 400, 'an unknown portal account is refused');

  // Switched off there: off here, signed out, cannot sign in. The owner is never switched off. Names follow.
  const qv2 = await login('qv@example.com', 'secret-pass-3');
  people[2].active = false;
  people[3].active = false;
  people[0].name_en = 'Quality assessor';
  people[0].phone = '0559876543';
  r = await owner('/fms-link/sync', 'POST');
  check(r.j.ok && r.j.snapshot.users.switched_off === 1 && r.j.snapshot.users.updated === 1, 'the sync switches off and renames', r.j);
  users = (await owner('/users')).j.users;
  const qvU = users.find((u) => u.email === 'qv@example.com');
  check(!qvU.active && qvU.portal_off, 'switched off in the portal, switched off here', qvU);
  check((await qv2('/bootstrap')).j.user === null, 'and signed out at once');
  check((await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email: 'qv@example.com', password: 'secret-pass-3' }) })).status !== 200, 'and cannot sign in');
  check(users.find((u) => u.email === 'owner@example.com').active, 'the system owner is never switched off');
  check(users.find((u) => u.email === 'qa@example.com').name_en === 'Quality assessor', 'a new name in the portal shows here');
  check(users.find((u) => u.email === 'qa@example.com').phone === '0559876543', 'and a mobile number too');
  // Back on there: back on here, because the sync switched it off.
  people[2].active = true;
  r = await owner('/fms-link/sync', 'POST');
  check(r.j.snapshot.users.switched_on === 1 && (await owner('/users')).j.users.find((u) => u.email === 'qv@example.com').active, 'switched back on there, back on here');
  // An account the admin switched off here stays off, even while the portal has it on.
  const newU = (await owner('/users')).j.users.find((u) => u.email === 'new@example.com');
  check((await owner('/users/' + newU.id, 'PUT', { ...newU, active: false })).s === 200, 'the admin switches a linked account off here');
  await owner('/fms-link/sync', 'POST');
  check(!(await owner('/users')).j.users.find((u) => u.email === 'new@example.com').active, 'and the sync does not switch it back on');
  // Deleted in the portal: switched off here too.
  people.splice(2, 1);
  await owner('/fms-link/sync', 'POST');
  check(!(await owner('/users')).j.users.find((u) => u.email === 'qv@example.com').active, 'deleted in the portal, switched off here');
  r = await owner('/logs');
  check(r.j.logs.some((l) => l.action === 'portal_off') && r.j.logs.some((l) => l.action === 'portal_link'), 'linking and switching off are in the activity log');
  // Switching the link off unlinks; the accounts stay.
  r = await owner('/fms-link', 'PUT', { on: false });
  users = (await owner('/users')).j.users;
  check(r.s === 200 && users.every((u) => !u.portal) && (await owner('/portal-users')).j.on === false, 'switching the link off unlinks the accounts and empties the list');
  const back = users.find((u) => u.email === 'qv@example.com');
  await owner('/users/' + back.id, 'PUT', { ...back, active: true });
  srv.close();
}

// Signing in from the Fikra portal: a one-minute token signed with the hash of a key that has the portal scope.
{
  const mk = async (scopes) => (await owner('/api-keys', 'POST', { name_ar: 'بوابة فكرة', name_en: 'Fikra portal', scopes })).j.key;
  const portalKey = await mk(['portal']);
  const otherKey = await mk(['assets_read']);
  const token = (key, over = {}) => {
    const body = Buffer.from(JSON.stringify({ e: 'tech@example.com', n: randomBytes(16).toString('hex'), x: Math.floor(Date.now() / 1000) + 60, a: B, ...over })).toString('base64url');
    return body + '.' + createHmac('sha256', createHash('sha256').update(key).digest('hex')).update(body).digest('hex');
  };
  const sso = async (t) => {
    const x = await fetch(B + '/api/sso', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ token: t }) });
    return { s: x.status, j: await x.json().catch(() => null), cookie: (x.headers.get('set-cookie') || '').split(';')[0] };
  };
  const good = token(portalKey);
  r = await sso(good);
  const me = r.cookie ? await fetch(B + '/api/bootstrap', { headers: { cookie: r.cookie } }).then((x) => x.json()) : {};
  check(r.s === 200 && r.cookie.startsWith('fm_session=') && me.user && me.user.email === 'tech@example.com', 'a portal link signs the same person in', r);
  check((await sso(good)).j?.error === 'sso_expired', 'each link works once');
  check((await sso(token(otherKey))).j?.error === 'sso_invalid', 'only a key with the portal scope signs people in');
  check((await sso(token(portalKey, { a: 'https://other.example' }))).j?.error === 'sso_invalid', 'a link made for another system is refused');
  check((await sso(token(portalKey, { x: Math.floor(Date.now() / 1000) - 5 }))).j?.error === 'sso_expired', 'an old link is refused');
  check((await sso(token(portalKey, { e: 'nobody@example.com' }))).j?.error === 'sso_no_account', 'no account here, no way in');
  check((await sso(good.slice(0, -1) + (good.endsWith('0') ? '1' : '0'))).j?.error === 'sso_invalid', 'a changed signature is refused');

  // The portal's users screen: list and set accounts and roles here, by email.
  const people = async (key, method = 'GET', body) => {
    const x = await fetch(B + '/api/v1/people', { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { s: x.status, j: await x.json().catch(() => null) };
  };
  r = await people(portalKey);
  check(r.s === 200 && r.j.apps.some((a) => a.key === 'quality_role' && a.options.length === 4) && r.j.people.some((p) => p.email === 'owner@example.com' && p.owner), 'the portal reads the accounts and the parts it can give', r.j && r.j.apps);
  check((await people(otherKey)).s === 403, 'only a key with the portal scope reads them');
  r = await people(portalKey, 'PUT', { email: 'New.Person@example.com', name: 'شخص جديد', name_en: 'New Person', phone: '0551234567', role: 'user', roles: { quality_role: 'assessor', meetings_role: 'bogus' }, by: 'Owner' });
  check(r.s === 200 && r.j.person.active && r.j.person.roles.quality_role === 'assessor' && r.j.person.roles.meetings_role === 'none', 'the portal gives someone an account and a role here', r.j);
  r = await people(portalKey, 'PUT', { email: 'new.person@example.com', role: 'systems_admin', roles: { quality_role: 'manager' } });
  check(r.s === 200 && r.j.person.role === 'systems_admin' && r.j.person.roles.quality_role === 'none', 'an admin needs no per-part roles', r.j);
  {
    const list = (await owner('/users')).j;
    const np = list && list.users.find((x) => x.email === 'new.person@example.com');
    check(np && np.phone === '0551234567', 'the mobile number comes with the account', np);
  }
  r = await people(portalKey, 'PUT', { email: 'new.person@example.com', account: false });
  check(r.s === 200 && r.j.person.active === false, 'and switches the account off', r.j);
  check((await people(portalKey, 'PUT', { email: 'owner@example.com', role: 'user' })).j?.error === 'owner_account', 'the owner account is never changed from the portal');
  const logs = (await owner('/logs?entity=user')).j;
  check(JSON.stringify(logs || {}).includes('(Owner)'), 'the log names the portal admin', logs && (logs.logs || logs).slice ? (logs.logs || logs).slice(0, 2) : logs);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

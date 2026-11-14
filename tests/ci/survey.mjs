// End-to-end checks for mock surveys, tracers and clinical audits: who can do what, scores kept apart from the
// official assessment until applied, CAPA on closing, a tracer's stations, an audit's compliance, its indicator,
// the improvement on closing and the re-audit. Runs after qplan.mjs.
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
const qm = await login('qm@example.com', 'secret-pass-5');
const qo = await login('qo@example.com', 'secret-pass-5');
const emp = await login('emp@example.com', 'secret-pass-5');
const dh = await login('dhead@example.com', 'secret-pass-5');
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
const [deptA] = depts;
const users = (await owner('/users')).j.users;
const idOf = (email) => users.find((u) => u.email === email).id;
const [qoId, empId] = ['qo@example.com', 'emp@example.com'].map(idOf);

/* ------------------------------- mock survey ------------------------------- */

// A chapter with a standard that has elements and one that has none.
let r = await owner('/standards', 'POST', { code: 'QM.40', title_ar: 'معيار للمسح', title_en: 'Survey standard', esr: 1, elements: [{ num: '1', text: 'First.' }, { num: '2', text: 'Second.' }] });
check(r.s === 200, 'a standard with elements', r.j);
const sEl = r.j.id;
r = await owner('/standards', 'POST', { code: 'QM.41', title_ar: 'معيار بلا عناصر', title_en: 'No elements' });
const sNo = r.j.id;
const before = (await owner('/standards?framework=cbahi&chapter=QM')).j.standards.find((s) => s.id === sEl);
const [e1, e2] = before.elements;

check((await emp('/mock')).s === 403, 'an employee does not see mock surveys');
check((await qo('/mock', 'POST', { title: 'x', chapters: ['QM'] })).s === 403, 'an assessor cannot start a survey');
check((await qm('/mock', 'POST', { title: 'x', chapters: ['ZZ'] })).j.error === 'mock_no_chapters', 'a survey needs chapters');
r = await qm('/mock', 'POST', { title: 'مسح تجريبي أول', framework: 'cbahi', chapters: ['QM', 'LD'], assign: { QM: qoId } });
check(r.s === 200 && /^MS-\d{3}$/.test(r.j.code), 'the quality manager starts a survey', r.j);
const mid = r.j.id;
r = await qo('/mock/' + mid);
check(r.s === 200 && r.j.chapters.length === 2 && r.j.chapters.find((c) => c.code === 'QM').can_score && r.j.chapters.find((c) => c.code === 'QM').user_id === qoId, 'the survey lists its chapters and who scores them', r.j);
r = await qo('/mock/' + mid + '/standards?chapter=QM');
check(r.s === 200 && r.j.standards.some((s) => s.id === sEl), 'the scoring page reads the chapter in the survey');
r = await qo('/mock/' + mid + '/score', 'PUT', { standard_id: sEl, element_id: e1.id, activities: [{ kind: 'document', score: 'met' }] });
check(r.s === 200 && r.j.element.score === 'met' && r.j.score === null, 'an element scored, the standard still open', r.j);
r = await qo('/mock/' + mid + '/score', 'PUT', { standard_id: sEl, element_id: e2.id, activities: [{ kind: 'observation', score: 'partial', note: 'ناقص' }] });
check(r.j.score === 'not_met', 'an ESR partly met counts as not met', r.j);
r = await qo('/mock/' + mid + '/score', 'PUT', { standard_id: sNo, element_id: 0, activities: [{ kind: 'interview', score: 'met' }] });
check(r.s === 200 && r.j.score === 'met', 'a standard with no elements is scored on its own');
check((await qo('/mock/' + mid + '/score', 'PUT', { standard_id: sEl, element_id: 0, activities: [{ kind: 'interview', score: 'met' }] })).s === 404, 'a standard with elements is scored by element');
const official = (await owner('/standards?framework=cbahi&chapter=QM')).j.standards.find((s) => s.id === sEl);
check(official.score === before.score && official.elements[0].score === before.elements[0].score, 'the official assessment is untouched');
r = await qm('/mock/' + mid);
check(r.j.esr_gaps.some((g) => g.id === sEl) && r.j.scored === 3, 'the report shows the ESR gap and the progress', r.j);

// Tracers inside the survey.
check((await emp('/tracers', 'POST', { kind: 'patient', mrn: '1' })).s === 403, 'an employee cannot start a tracer');
check((await qo('/tracers', 'POST', { kind: 'patient' })).j.error === 'tracer_mrn', 'a patient tracer needs the record number');
r = await qo('/tracers', 'POST', { kind: 'patient', mrn: 'MRN-77', department_id: deptA.id, survey_id: mid });
check(r.s === 200 && /^TR-\d{3}$/.test(r.j.code), 'an assessor starts a patient tracer', r.j);
const tid = r.j.id;
r = await qo('/tracers/' + tid);
const n0 = r.j.items.length;
check(n0 === 10 && r.j.items.every((i) => i.station), 'the first station brings its questions', n0);
check((await qo('/tracers/' + tid + '/items', 'POST', { department_id: depts[1] ? depts[1].id : deptA.id })).s === 200, 'the next station on the path');
check((await qo('/tracers/' + tid + '/items', 'POST', { question: 'سؤال إضافي' })).s === 200, 'a question of its own');
r = await qo('/tracers/' + tid);
check(r.j.items.length === n0 * 2 + 1, 'the questions are added', r.j.items.length);
const items = r.j.items;
check((await qo('/tracers/' + tid + '/close', 'POST', {})).j.error === 'tracer_open_items', 'every line needs an answer');
for (const i of items) await qo('/tracers/' + tid + '/items/' + i.id, 'PUT', { result: 'met' });
await qo('/tracers/' + tid + '/items/' + items[3].id, 'PUT', { result: 'not_met' });
check((await qo('/tracers/' + tid + '/close', 'POST', {})).j.error === 'std_gap_note', 'a line not met needs a note');
await qo('/tracers/' + tid + '/items/' + items[3].id, 'PUT', { result: 'not_met', note: 'ثلاجة بلا سجل' });
check((await qm('/tracers/' + tid + '/items/' + items[3].id, 'PUT', { result: 'not_met', note: 'ثلاجة بلا سجل' })).s === 200, 'the quality manager can edit too');
check((await emp('/tracers/' + tid + '/items/' + items[3].id, 'PUT', { result: 'met' })).s === 403, 'an employee cannot');
r = await qo('/tracers/' + tid + '/close', 'POST', { summary: 'جيد' });
check(r.s === 200 && r.j.capa === 1, 'closing opens a CAPA for the line not met', r.j);
r = await qo('/tracers', 'POST', { kind: 'system', topic: 'medication' });
check(r.s === 200, 'a system tracer');
check((await qo('/tracers/' + r.j.id)).j.items.length === 8, 'with its list');
check((await qo('/tracers', 'POST', { kind: 'system', topic: 'x' })).s === 400, 'a known topic only');

// Closing and applying the survey.
check((await qo('/mock/' + mid + '/close', 'POST', {})).s === 403, 'only the quality manager closes a survey');
check((await qm('/mock/' + mid + '/apply', 'POST')).j.error === 'mock_not_closed', 'a survey is applied after closing');
r = await qm('/mock/' + mid + '/close', 'POST', { result: 'جاهزية جيدة' });
check(r.s === 200 && r.j.capa === 1, 'closing opens a CAPA for each standard with a gap', r.j);
check((await qo('/mock/' + mid + '/score', 'PUT', { standard_id: sNo, element_id: 0, activities: [{ kind: 'interview', score: 'na' }] })).s === 403, 'a closed survey cannot be scored');
const capa = (await qm('/capa')).j.capa;
check(capa.some((c) => c.source === 'mock' && c.std_code === 'QM.40') && capa.some((c) => c.source === 'tracer'), 'the CAPAs are there', capa.slice(0, 3));
r = await qm('/mock/' + mid + '/apply', 'POST');
check(r.s === 200 && r.j.standards === 2, 'the manager applies the scores', r.j);
check((await qm('/mock/' + mid + '/apply', 'POST')).j.error === 'mock_applied', 'once');
const after = (await owner('/standards?framework=cbahi&chapter=QM')).j.standards;
check(after.find((s) => s.id === sEl).score === 'not_met' && after.find((s) => s.id === sNo).score === 'met' && after.find((s) => s.id === sEl).elements[0].activities.length === 1, 'the official assessment now has them', after.find((s) => s.id === sEl));
r = await qm('/mock', 'POST', { title: 'المسح الثاني', chapters: ['QM'] });
const mid2 = r.j.id;
r = await qm('/mock/' + mid2);
check(r.j.prev && r.j.prev.id === mid, 'the next survey compares with the last one', r.j.prev);
r = await qm('/mock');
check(r.j.surveys.length >= 2 && r.j.tracers.length >= 2, 'the list');
check((await qo('/mock/' + mid2, 'DELETE')).s === 403 && (await qm('/mock/' + mid2, 'DELETE')).s === 200, 'only the manager deletes a survey');

/* ------------------------------ clinical audits ------------------------------ */

check((await emp('/audits')).s === 403, 'an employee does not see audits');
r = await qm('/audits');
check(r.s === 200 && r.j.library.length >= 6, 'the library', r.j.library && r.j.library.length);
const lib = r.j.library.find((x) => x.key === 'allergy');
check((await qm('/audits', 'POST', { title: 'x', criteria: [] })).j.error === 'audit_no_criteria', 'an audit needs criteria');
r = await qm('/kpis', 'POST', { code: 'CA-ALG', name_ar: 'توثيق الحساسية', name_en: 'Allergy documentation', unit: 'pct', direction: 'up', target: 95, frequency: 'monthly', source: 'manual', active: true });
const kpiId = r.j.id;
r = await qo('/audits', 'POST', { title: 'تدقيق توثيق الحساسية', library: 'allergy', criteria: lib.criteria, department_id: deptA.id, owner_id: empId, sample: 10, kpi_id: kpiId });
check(r.s === 200 && /^CA-\d{3}$/.test(r.j.code), 'an assessor starts an audit from the library', r.j);
const aid = r.j.id;
check((await emp('/bootstrap')).j.user.audit === 'member', 'its owner opens audits');
r = await emp('/audits/' + aid);
check(r.s === 200 && r.j.can_enter && !r.j.can_close, 'the owner enters cases, does not close', r.j);
const crit = r.j.criteria;
check((await emp('/audits/' + aid + '/cases', 'POST', { mrn: '1', answers: { [crit[0].id]: 'y' } })).j.error === 'audit_answer_all', 'every criterion needs an answer');
const all = (v) => Object.fromEntries(crit.map((c) => [c.id, v]));
const day = new Date().toISOString().slice(0, 10);
check((await emp('/audits/' + aid + '/cases', 'POST', { mrn: '100', case_date: day, answers: all('y') })).s === 200, 'a case');
await emp('/audits/' + aid + '/cases', 'POST', { mrn: '101', case_date: day, answers: { ...all('y'), [crit[1].id]: 'n' } });
r = await emp('/audits/' + aid + '/cases', 'POST', { mrn: '102', case_date: day, answers: { ...all('y'), [crit[1].id]: 'n', [crit[2].id]: 'na' } });
const lastCase = r.j.id;
r = await qm('/audits/' + aid);
const c1 = r.j.criteria[1];
check(r.j.cases === 3 && c1.pct === 33 && c1.met === false && r.j.criteria[2].pct === 100 && r.j.pct === Math.round((9 / 11) * 100), 'compliance per criterion and overall', r.j.criteria);
const kv = (await qm('/kpis')).j.kpis.find((k) => k.id === kpiId);
check(kv.values.length === 1 && kv.values[0].value === Math.round((9 / 11) * 10000) / 100, 'the indicator gets the month', kv.values);
check((await emp('/audits/' + aid + '/cases/' + lastCase, 'DELETE')).s === 200, 'the owner removes their case');
check((await qm('/audits/' + aid, 'PUT', { title: 'تدقيق توثيق الحساسية', criteria: [{ text: 'جديد', target: 90 }] })).j.error === 'audit_has_cases', 'criteria stay once cases are in');
check((await emp('/audits/' + aid + '/close', 'POST', { plan: 'capa' })).s === 403, 'the owner cannot close');
r = await qo('/audits/' + aid + '/close', 'POST', { plan: 'capa', result: 'توثيق ناقص' });
check(r.s === 200 && r.j.made === 1, 'closing opens a CAPA for the criterion below target', r.j);
check((await emp('/audits/' + aid + '/cases', 'POST', { mrn: '9', answers: all('y') })).s === 403, 'no cases after closing');
r = await qo('/audits/' + aid + '/reaudit', 'POST');
check(r.s === 200, 'a re-audit', r.j);
const aid2 = r.j.id;
check((await qo('/audits/' + aid + '/reaudit', 'POST')).j.error === 'audit_reaudited', 'once');
const crit2 = (await emp('/audits/' + aid2)).j.criteria;
check(crit2.length === crit.length, 'with the same criteria');
await emp('/audits/' + aid2 + '/cases', 'POST', { mrn: '200', answers: Object.fromEntries(crit2.map((c) => [c.id, 'y'])) });
r = await qm('/audits/' + aid2);
check(r.j.audit.n_round === 2 && r.j.prev && r.j.prev.id === aid && r.j.prev.criteria[2] === 50 && r.j.criteria[1].pct === 100, 'the re-audit compares criterion by criterion', r.j.prev);
r = await qo('/audits/' + aid2 + '/close', 'POST', { plan: 'pdsa' });
check(r.s === 200 && r.j.made === 0, 'nothing below target, no project', r.j);
// A department head runs their department's audits.
r = await dh('/audits', 'POST', { title: 'تدقيق القسم', criteria: [{ text: 'بند', target: 90 }] });
check(r.s === 200, 'a department head starts an audit', r.j);
const aid3 = r.j.id;
await dh('/audits/' + aid3 + '/cases', 'POST', { mrn: '300', answers: { [(await dh('/audits/' + aid3)).j.criteria[0].id]: 'n' } });
r = await dh('/audits/' + aid3 + '/close', 'POST', { plan: 'pdsa' });
check(r.s === 200 && r.j.pdsa_id, 'closing with a PDSA project', r.j);
check((await qm('/pdsa/' + r.j.pdsa_id)).j.project.source === 'audit', 'the project comes from the audit');
check((await qo('/audits/' + aid3, 'DELETE')).s === 403 && (await qm('/audits/' + aid3, 'DELETE')).s === 200, 'only the quality manager deletes an audit');

// The quality report carries them.
r = await qm('/qreport?period=' + day.slice(0, 7));
check(r.s === 200 && r.j.mock.survey && r.j.mock.survey.id === mid && r.j.mock.tracers.n === 1 && r.j.audits.length >= 2, 'the quality report shows the survey, tracers and audits', { mock: r.j.mock, audits: r.j.audits });

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

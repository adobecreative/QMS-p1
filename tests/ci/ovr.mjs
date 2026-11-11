// End-to-end checks for incident reports (OVR): the form signed in and from a QR code, who sees the reporter
// and the patient, receiving, sending for a reply and for action, closing, reopening and the categories.
// Runs after meetings.mjs, on the same data. Each check prints PASS or FAIL; any FAIL makes the run fail.

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
  api.form = async (path, fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const r = await fetch(B + '/api' + path, { method: 'POST', headers: { cookie, 'x-requested-with': 'fetch' }, body: fd });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const r = await api('/login', 'POST', { email, password });
  check(r.s === 200, 'sign in ' + email, r);
  return api;
};
const publicForm = async (fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const r = await fetch(B + '/api/public/ovr', { method: 'POST', headers: { 'x-requested-with': 'fetch' }, body: fd });
  return { s: r.status, j: await r.json().catch(() => null) };
};
const sent = async () => JSON.stringify(await (await fetch(B + '/api/__sent')).json());

const owner = await login('owner@example.com', 'secret-pass-1');
await owner('/settings', 'PUT', { mail_provider: 'brevo', brevo_key: 'test-key', mail_from: 'qms@example.com', site_url: 'https://qms.example.com' });
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
const [deptA, deptB] = depts;
const add = (email, quality_role, name, department_id) => owner('/users', 'POST', { name, name_en: 'Person', email, role: 'user', password: 'secret-pass-5', quality_role, department_id });
check((await add('qm@example.com', 'manager', 'مدير الجودة', deptA.id)).s === 200, 'owner adds a quality manager');
check((await add('qo@example.com', 'assessor', 'مسؤول الجودة', deptA.id)).s === 200, 'owner adds a quality officer');
check((await add('emp@example.com', 'none', 'موظف مبلغ', deptB.id)).s === 200, 'owner adds an employee with no quality role');
check((await add('head@example.com', 'none', 'رئيس القسم', deptB.id)).s === 200, 'owner adds a department head');
const qm = await login('qm@example.com', 'secret-pass-5');
const qo = await login('qo@example.com', 'secret-pass-5');
const emp = await login('emp@example.com', 'secret-pass-5');
const head = await login('head@example.com', 'secret-pass-5');
await sent();

// The form: categories with their own sub-categories, added once.
let r = await emp('/public/ovr/form');
const cats = r.j.categories;
const tops = cats.filter((c) => !c.parent_id);
const med = tops.find((c) => c.name_en === 'Medication');
const medSubs = cats.filter((c) => c.parent_id === med.id);
check(r.s === 200 && r.j.signed_in && tops.length >= 14 && medSubs.length >= 5, 'the form has the starter categories, each with its sub-categories', { tops: tops.length, subs: medSubs.length });
const wrongSite = cats.find((c) => c.name_en === 'Wrong site or wrong patient surgery');
check(wrongSite && wrongSite.sentinel === 1, 'wrong-site surgery is marked as a sentinel event');
r = await emp('/public/ovr/form');
check(r.j.categories.length === cats.length, 'the starter categories are not added twice');

const base = { occurred_at: new Date().toISOString().slice(0, 16), department_id: String(deptB.id), category_id: String(med.id), sub_id: String(medSubs[0].id), harm: 'minor', description: 'أعطي المريض جرعة مضاعفة من الدواء', patient: '1', patient_mrn: 'MRN-55821', patient_name: 'سالم المريض' };
check((await emp.form('/public/ovr', { ...base, patient_name: '' })).j.error === 'ovr_patient_required', 'a report about a patient needs the file number and the name');
check((await emp.form('/public/ovr', { ...base, sub_id: '' })).j.error === 'ovr_bad_sub', 'a category with sub-categories needs one');
check((await emp.form('/public/ovr', { ...base, harm: 'bad' })).j.error === 'ovr_bad_harm', 'the harm level must be one of the six');
r = await emp.form('/public/ovr', base);
check(r.s === 200 && r.j.id > 0, 'a signed-in employee sends a report', r.j);
const id1 = r.j.id;
let mail = await sent();
check(mail.includes('qm@example.com') && mail.includes('qo@example.com') && mail.includes('emp@example.com'), 'quality is told of the new report and the reporter gets a receipt');
check(!mail.includes('MRN-55821') && !mail.includes('سالم المريض') && !mail.includes('موظف مبلغ'), 'the emails carry neither the patient nor the reporter');

// From a place's QR code, with an employee number from the staff list.
const staff = (await owner('/staff')).j.staff;
check((await publicForm({ ...base, patient: '0', emp_no: '' })).j.error === 'ovr_emp_required', 'without signing in the employee number is required');
check((await publicForm({ ...base, patient: '0', emp_no: 'NO-SUCH-9' })).j.error === 'ovr_emp_unknown', 'an employee number not on the staff list is refused');
r = await publicForm({ ...base, patient: '0', emp_no: staff[0].emp_no, category_id: String(wrongSite.parent_id), sub_id: String(wrongSite.id), harm: 'minor' });
check(r.s === 200 && /^[0-9a-f]{32}$/.test(r.j.track), 'a report is sent from the QR page with an employee number', r.j);
const id2 = r.j.id;
mail = await sent();
check(mail.includes('owner@example.com') === false, 'the hidden system owner is not emailed');
r = await fetch(B + '/api/public/ovr/' + id2 + '?k=' + r.j.track).then((x) => x.json());
check(r.ovr && r.ovr.status === 'new' && r.ovr.description === undefined, 'the tracking link shows where it stands, without the details', r);
check((await fetch(B + '/api/public/ovr/' + id2 + '?k=' + '0'.repeat(32))).status === 404, 'a wrong tracking key finds nothing');

// Who sees what.
r = await qo('/ovr');
const r2 = r.j.ovr.find((o) => o.id === id2);
check(r.s === 200 && r2 && r2.harm === 'sentinel', 'a sentinel sub-category makes the report a sentinel event', r2);
check(r.j.ovr.every((o) => o.reporter === undefined), 'the quality officer never sees who reported');
r = await qm('/ovr');
check(r.j.ovr.find((o) => o.id === id1).reporter.name === 'موظف مبلغ' && r.j.ovr.find((o) => o.id === id2).reporter.emp_no === staff[0].emp_no, 'the quality manager sees who reported, name and number');
r = await owner('/ovr');
check(r.s === 200 && r.j.ovr.every((o) => o.reporter === undefined), 'a system admin without the quality manager role does not see the reporter');
r = await emp('/ovr');
check(r.j.ovr.length === 1 && r.j.ovr[0].id === id1 && r.j.ovr[0].mine, 'an employee sees only their own reports');
r = await emp('/ovr/' + id1);
check(r.s === 200 && r.j.ovr.patient_mrn === 'MRN-55821' && r.j.ovr.reporter === undefined && r.j.ovr.steps === undefined, 'the reporter sees their report, not the steps');
check((await head('/ovr/' + id1)).s === 404, 'someone it was not sent to cannot open it');
r = await qo('/ovr/' + id1);
check(r.j.ovr.patient_name === 'سالم المريض' && r.j.ovr.reporter === undefined, 'quality sees the patient but not the reporter');

// Receive, send for a reply, answer.
check((await emp('/ovr/' + id1, 'PUT', { harm_final: 'moderate' })).s === 403, 'an employee cannot classify');
r = await qo('/ovr/' + id1, 'PUT', { harm_final: 'moderate' });
r = await qo('/ovr/' + id1);
check(r.j.ovr.status === 'review' && r.j.ovr.harm_final === 'moderate' && r.j.ovr.steps.some((s) => s.kind === 'receive'), 'quality receives the report and sets the harm', r.j.ovr);
const headId = (await owner('/users')).j.users.find((u) => u.email === 'head@example.com').id;
check((await qo('/ovr/' + id1 + '/route', 'POST', { user_id: 999999, kind: 'reply' })).j.error === 'ovr_bad_person', 'it cannot be sent to an unknown account');
r = await qo('/ovr/' + id1 + '/route', 'POST', { user_id: headId, kind: 'reply', note: 'نرجو التوضيح' });
check(r.s === 200, 'quality sends it to the department head for a reply', r.j);
check((await qo('/ovr/' + id1 + '/route', 'POST', { user_id: headId, kind: 'reply' })).j.error === 'ovr_task_exists', 'the same request is not sent twice');
mail = await sent();
check(mail.includes('head@example.com') && !mail.includes('سالم المريض'), 'the department head is emailed, without the patient');
r = await head('/ovr');
check(r.j.ovr.length === 1 && r.j.ovr[0].my_task && r.j.ovr[0].my_task.kind === 'reply' && r.j.ovr[0].status === 'reply', 'the department head sees it, waiting for their reply');
r = await head('/ovr/' + id1);
const task = r.j.ovr.tasks[0];
check(r.j.ovr.patient_mrn === 'MRN-55821' && r.j.ovr.reporter === undefined && r.j.ovr.tasks.length === 1, 'the department head sees the patient but not the reporter');
check((await qo('/ovr/' + id1 + '/tasks/' + task.id, 'POST', { reply: 'x' })).s === 403, 'only the person it was sent to answers');
check((await head('/ovr/' + id1 + '/tasks/' + task.id, 'POST', { reply: '' })).j.error === 'ovr_reply_required', 'a reply cannot be empty');
check((await head('/ovr/' + id1 + '/tasks/' + task.id, 'POST', { reply: 'تمت مراجعة الصرف مع الصيدلية' })).s === 200, 'the department head replies');
check((await qo('/ovr/' + id1)).j.ovr.status === 'review', 'after the reply the report is back with quality');
mail = await sent();
check(mail.includes('qo@example.com'), 'whoever sent it is told of the reply');

// Send for action: always a correction and an improvement.
r = await qo('/ovr/' + id1 + '/route', 'POST', { user_id: headId, kind: 'action' });
check(r.s === 200 && (await qo('/ovr/' + id1)).j.ovr.status === 'action', 'quality sends it for action');
check((await qo('/ovr/' + id1 + '/close', 'POST', { note: 'x' })).j.error === 'ovr_tasks_open', 'it cannot close while someone has not answered');
const t2 = (await head('/ovr/' + id1)).j.ovr.tasks.find((x) => x.kind === 'action' && x.status === 'open');
check((await head('/ovr/' + id1 + '/tasks/' + t2.id, 'POST', { correction: 'تصحيح الجرعة' })).j.error === 'ovr_action_required', 'an action needs both a correction and an improvement');
check((await head('/ovr/' + id1 + '/tasks/' + t2.id, 'POST', { correction: 'تصحيح الجرعة', improvement: 'تدقيق مزدوج للأدوية عالية الخطورة' })).s === 200, 'the department head records the correction and the improvement');
check((await qo('/ovr/' + id1 + '/close', 'POST', { note: '' })).j.error === 'ovr_note_required', 'closing needs a note');
await sent();
check((await qo('/ovr/' + id1 + '/close', 'POST', { note: 'تم التصحيح والتحسين' })).s === 200, 'quality closes the report');
mail = await sent();
check(mail.includes('emp@example.com') && mail.includes('head@example.com'), 'the reporter and the department head are told it closed');
check((await qo('/ovr/' + id1 + '/reopen', 'POST', { note: 'x' })).s === 403, 'a quality officer cannot reopen');
check((await qm('/ovr/' + id1 + '/reopen', 'POST', { note: 'نحتاج متابعة' })).s === 200 && (await qm('/ovr/' + id1)).j.ovr.status === 'review', 'the quality manager reopens it');

// Withdrawing a task sent to the wrong person.
await qo('/ovr/' + id2 + '/route', 'POST', { user_id: headId, kind: 'reply' });
const t3 = (await qo('/ovr/' + id2)).j.ovr.tasks[0];
check((await qo('/ovr/' + id2 + '/tasks/' + t3.id, 'DELETE')).s === 200 && (await qo('/ovr/' + id2)).j.ovr.status === 'review', 'quality withdraws a task');

// Categories: the quality manager keeps them.
check((await qo('/ovr/cats', 'POST', { name_ar: 'تجربة', name_en: 'Test' })).s === 403, 'a quality officer cannot add a category');
r = await qm('/ovr/cats', 'POST', { name_ar: 'نوع تجريبي', name_en: 'Test type', chapter: 'qm' });
check(r.s === 200, 'the quality manager adds a category');
const newCat = r.j.id;
r = await qm('/ovr/cats', 'POST', { name_ar: 'فرعي', name_en: 'Sub', parent_id: newCat, sentinel: true });
check(r.s === 200, 'and a sub-category under it');
check((await qm('/ovr/cats/' + med.id, 'DELETE')).j.error === 'ovr_cat_used', 'a category with reports cannot be deleted');
check((await qm('/ovr/cats/' + newCat, 'DELETE')).s === 200, 'an unused category is deleted with its sub-categories');
check((await qm('/ovr/cats/' + medSubs[1].id, 'PUT', { active: false })).s === 200 && !(await emp('/public/ovr/form')).j.categories.some((c) => c.id === medSubs[1].id), 'a sub-category switched off leaves the form');

// The home page numbers.
r = await qo('/home');
check(r.j.ovr && r.j.ovr.open >= 2, 'quality sees the open reports on the home page', r.j.ovr);
r = await emp('/home');
check(r.j.ovr && r.j.ovr.mine === 1, 'an employee sees their own reports on the home page', r.j.ovr);
check((await qm('/ovr/' + id2, 'DELETE')).s === 200 && (await qm('/ovr/' + id2)).s === 404, 'the quality manager deletes a report');

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

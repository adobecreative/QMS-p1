// End-to-end checks for incident reports, phase 2: the corrective action an action opens, the root cause analysis
// (automatic for sentinel events, staged, approved by the quality manager into actions). Committee absences open an
// investigation instead (inv.mjs). Runs after ovr.mjs, on the same data and accounts.

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
const sent = async () => JSON.stringify(await (await fetch(B + '/api/__sent')).json());
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = await login('owner@example.com', 'secret-pass-1');
const qm = await login('qm@example.com', 'secret-pass-5');
const qo = await login('qo@example.com', 'secret-pass-5');
const emp = await login('emp@example.com', 'secret-pass-5');
const head = await login('head@example.com', 'secret-pass-5');
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
check((await owner('/users', 'POST', { name: 'الموارد البشرية', name_en: 'HR', email: 'hr@example.com', role: 'user', password: 'secret-pass-5', department_id: depts[0].id })).s === 200, 'owner adds a human resources officer');
const hrApi = await login('hr@example.com', 'secret-pass-5');
const users = (await owner('/users')).j.users;
const idOf = (email) => users.find((u) => u.email === email).id;
const headId = idOf('head@example.com');
const empId = idOf('emp@example.com');
const hrId = (await owner('/users')).j.users.find((u) => u.email === 'hr@example.com').id;
const cats = (await emp('/public/ovr/form')).j.categories;
const med = cats.find((c) => c.name_en === 'Medication');
const medSub = cats.find((c) => c.parent_id === med.id && c.active);
const wrongSite = cats.find((c) => c.name_en === 'Wrong site or wrong patient surgery');
const today = (await qo('/ovr')).j.today;
const base = { occurred_at: today + 'T09:00', department_id: String(depts[1].id), category_id: String(med.id), sub_id: String(medSub.id), harm: 'moderate', description: 'تأخر إعطاء الدواء ساعتين', patient: '0' };
await sent();

// A corrective action from an action sent to a person.
let r = await emp.form('/public/ovr', base);
const idA = r.j.id;
await qo('/ovr/' + idA, 'PUT', {});
check((await qo('/ovr/' + idA + '/close', 'POST', { note: 'x' })).j.error === 'ovr_capa_required', 'moderate harm cannot close without a corrective action');
r = await qo('/ovr/' + idA);
check(r.j.ovr.capa_needed === true && r.j.ovr.capa.length === 0, 'the report shows a corrective action is needed');
check((await qo('/ovr/' + idA + '/route', 'POST', { user_id: headId, kind: 'action', note: 'راجع جدول الإعطاء' })).s === 200, 'quality sends it for action');
r = await qo('/ovr/' + idA);
let capa = r.j.ovr.capa;
const task = r.j.ovr.tasks.find((x) => x.kind === 'action');
check(capa.length === 1 && capa[0].status === 'open' && task.capa_id === capa[0].id, 'the action opened a corrective action tied to the report', r.j.ovr);
r = await qm('/capa');
const c1 = r.j.capa.find((x) => x.id === capa[0].id);
check(c1 && c1.source === 'ovr' && c1.ovr_id === idA && c1.owner === 'رئيس القسم', 'the CAPA register shows it, from the report, owned by the person', c1);
check((await head('/ovr/' + idA)).j.ovr.tasks[0].capa_id === null, 'the person it was sent to does not get the CAPA link');
check((await qo('/ovr/' + idA + '/tasks/' + task.id, 'DELETE')).s === 200 && !(await qm('/capa')).j.capa.some((x) => x.id === capa[0].id), 'withdrawing the action removes its corrective action');
await qo('/ovr/' + idA + '/route', 'POST', { user_id: headId, kind: 'action' });
const t2 = (await head('/ovr/' + idA)).j.ovr.tasks.find((x) => x.status === 'open');
check((await head('/ovr/' + idA + '/tasks/' + t2.id, 'POST', { correction: 'إعطاء الجرعة فورًا', improvement: 'تنبيه في النظام للجرعات' })).s === 200, 'the person records the correction and the improvement');
capa = (await qo('/ovr/' + idA)).j.ovr.capa;
const c2 = (await qm('/capa')).j.capa.find((x) => x.id === capa[0].id);
check(c2.status === 'done' && c2.action.includes('إعطاء الجرعة فورًا') && c2.action.includes('تنبيه في النظام'), 'its corrective action is done with the same words', c2);
check((await qo('/ovr/' + idA + '/close', 'POST', { note: 'تم' })).s === 200, 'now the report closes');

// Root cause analysis: opened on its own for a sentinel event.
r = await emp.form('/public/ovr', { ...base, category_id: String(wrongSite.parent_id), sub_id: String(wrongSite.id), harm: 'minor' });
const idS = r.j.id;
r = await qo('/ovr/' + idS);
let rca = r.j.ovr.rca;
check(rca && rca.stage === 'team' && rca.team_due === plus(today, 3) && rca.analysis_due === plus(today, 21) && rca.plan_due === plus(today, 30), 'a sentinel event opens its root cause analysis with the three deadlines', rca);
check(r.j.ovr.steps.some((s) => s.kind === 'rca_open'), 'the history shows the analysis opened');
check((await qo('/ovr/' + idS + '/close', 'POST', { note: 'x' })).j.error === 'ovr_rca_open', 'the report cannot close before the analysis is approved');
check((await emp('/ovr/' + idS)).j.ovr.rca === undefined, 'the reporter does not see the analysis');
check((await head('/ovr/' + idS + '/rca', 'PUT', { team: [headId] })).s === 404, 'someone outside the team cannot open it');
await sent();
r = await qo('/ovr/' + idS + '/rca', 'PUT', { team: [headId] });
check(r.s === 200 && r.j.stage === 'team', 'one member is not a team yet', r.j);
r = await qo('/ovr/' + idS + '/rca', 'PUT', { team: [headId, empId], timeline: [{ at: today + 'T08:00', text: 'دخول المريض للعمليات' }] });
check(r.s === 200 && r.j.stage === 'analysis', 'with two members the team stage is done', r.j);
let mail = await sent();
check(mail.includes('head@example.com') && mail.includes('emp@example.com') && !mail.includes('سالم'), 'the team members are told they were added');
r = await head('/ovr');
check(r.j.ovr.some((o) => o.id === idS), 'a team member finds the report in their list');
r = await head('/ovr/' + idS);
check(r.s === 200 && r.j.ovr.rca.can_edit && r.j.ovr.reporter === undefined, 'a team member opens the analysis, without the reporter', r.j.ovr.rca);
check((await head('/ovr/' + idS + '/rca', 'PUT', { team: [headId] })).s === 403, 'a team member cannot take others off the team');
const bones = { people: [{ t: 'إرهاق الفريق' }], methods: [{ t: 'لا يوجد تعليم موضع العملية', root: true }], equipment: [], environment: [], materials: [], communication: [{ t: 'تسليم ناقص' }] };
const analysis = { team: [headId, empId], problem: 'جراحة في الموضع الخطأ', whys: ['لم يُعلَّم الموضع', 'لا توجد سياسة', '', '', ''], bones };
r = await head('/ovr/' + idS + '/rca', 'PUT', analysis);
check(r.s === 200 && r.j.stage === 'plan', 'a root cause marked on the fishbone ends the analysis stage', r.j);
r = await qo('/ovr/' + idS);
rca = r.j.ovr.rca;
check(rca.bones.methods[0].root === true && rca.whys.length === 2 && rca.problem === 'جراحة في الموضع الخطأ' && rca.timeline.length === 0, 'the five whys and the fishbone are kept (the timeline was replaced)', rca);
check(r.j.ovr.steps.some((s) => s.kind === 'rca_team') && r.j.ovr.steps.some((s) => s.kind === 'rca_analysis'), 'the history shows each stage done');
check((await qo('/ovr/' + idS + '/rca/approve', 'POST')).s === 403, 'a quality officer cannot approve the plan');
check((await qm('/ovr/' + idS + '/rca/approve', 'POST')).j.error === 'ovr_rca_plan', 'the plan needs at least one line');
await head('/ovr/' + idS + '/rca', 'PUT', { ...analysis, plan: [{ text: 'تطبيق تعليم الموضع قبل كل عملية' }] });
check((await qm('/ovr/' + idS + '/rca/approve', 'POST')).j.error === 'ovr_rca_plan', 'each line needs an owner and a date');
await head('/ovr/' + idS + '/rca', 'PUT', { ...analysis, plan: [{ text: 'تطبيق تعليم الموضع قبل كل عملية', owner_id: headId, due: plus(today, 20) }] });
check((await qm('/ovr/' + idS + '/rca/approve', 'POST')).j.error === 'ovr_rca_measure', 'the plan needs an effectiveness measure');
await head('/ovr/' + idS + '/rca', 'PUT', { ...analysis, plan: [{ text: 'تطبيق تعليم الموضع قبل كل عملية', owner_id: headId, due: plus(today, 20) }], measure: 'نسبة العمليات المعلَّم موضعها 100٪' });
await sent();
check((await qm('/ovr/' + idS + '/rca/approve', 'POST')).s === 200, 'the quality manager approves the plan');
r = await qm('/ovr/' + idS);
rca = r.j.ovr.rca;
const planTask = r.j.ovr.tasks.find((x) => x.kind === 'action');
check(rca.stage === 'approved' && rca.approved_by === 'مدير الجودة' && r.j.ovr.status === 'action', 'the analysis is approved and the report waits for action', { rca, status: r.j.ovr.status });
check(planTask && planTask.user_id === headId && planTask.due === plus(today, 20) && planTask.note === 'تطبيق تعليم الموضع قبل كل عملية' && planTask.capa_id, 'each plan line went to its owner as an action', planTask);
const c3 = (await qm('/capa')).j.capa.find((x) => x.id === planTask.capa_id);
check(c3 && c3.source === 'rca' && c3.ovr_id === idS && c3.due === plus(today, 20), 'and opened its corrective action', c3);
mail = await sent();
check(mail.includes('head@example.com'), 'the owner is told');
check((await head('/ovr/' + idS + '/rca', 'PUT', analysis)).j.error === 'ovr_rca_locked', 'an approved analysis is locked');
check((await head('/ovr/' + idS + '/tasks/' + planTask.id, 'POST', { correction: 'تعليم الموضع', improvement: 'قائمة تحقق إلزامية' })).s === 200, 'the owner records the action');
check((await qo('/ovr/' + idS + '/close', 'POST', { note: 'اكتمل' })).s === 200, 'the sentinel report closes once everything is done');

// The quality manager asks for an analysis on any report, and can take it back.
r = await emp.form('/public/ovr', { ...base, harm: 'minor' });
const idM = r.j.id;
check((await qo('/ovr/' + idM, 'PUT', { rca: true })).s === 403, 'a quality officer cannot ask for an analysis on a minor report');
check((await qm('/ovr/' + idM, 'PUT', { rca: true })).s === 200 && (await qm('/ovr/' + idM)).j.ovr.rca.stage === 'team', 'the quality manager opens one');
check((await qm('/ovr/' + idM, 'PUT', { rca: false })).s === 200 && (await qm('/ovr/' + idM)).j.ovr.rca === undefined, 'and takes it back');
check((await qm('/ovr/' + idS, 'PUT', { rca: false })).j.error === 'ovr_closed', 'a closed report cannot change');

// The daily run reminds without failing; deleting a report removes its analysis and corrective actions.
check((await owner('/settings/run-reminders', 'POST')).s !== 500, 'the daily run works with analyses open');
check((await qm('/ovr/' + idS, 'DELETE')).s === 200 && !(await qm('/capa')).j.capa.some((x) => x.ovr_id === idS), 'deleting a report removes its corrective actions');

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

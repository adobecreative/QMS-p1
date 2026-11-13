// End-to-end checks for the annual quality plan, the improvement projects (PDSA) and the quality report:
// who sees what, the suggestion from an indicator below target, cycles, closing, goal status worked out from
// the indicator, the project and the quarter, approval, the report and its monthly email. Runs after pex.mjs.
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
const sent = async () => JSON.stringify(await (await fetch(B + '/api/__sent')).json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const prevM = (m) => (m.slice(5) === '01' ? `${Number(m.slice(0, 4)) - 1}-12` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) - 1).padStart(2, '0')}`);

const owner = await login('owner@example.com', 'secret-pass-1');
const qm = await login('qm@example.com', 'secret-pass-5');
const qo = await login('qo@example.com', 'secret-pass-5');
const emp = await login('emp@example.com', 'secret-pass-5');
const dh = await login('dhead@example.com', 'secret-pass-5');
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
const [deptA, deptB] = depts;
const users = (await owner('/users')).j.users;
const idOf = (email) => users.find((u) => u.email === email).id;
const [empId, dhId] = ['emp@example.com', 'dhead@example.com'].map(idOf);
const boot = async (api) => (await api('/bootstrap')).j.user.plan;
await sent();

check((await boot(qm)) === 'manager' && (await boot(qo)) === 'officer' && (await boot(dh)) === 'dept' && (await boot(emp)) === 'none', 'who opens the plan and the projects');

// An indicator below its target three months running is suggested for a project.
let r = await qm('/kpis', 'POST', { code: 'QP-HH', name_ar: 'الالتزام بنظافة اليدين', name_en: 'Hand hygiene', unit: 'pct', direction: 'up', target: 90 });
check(r.s === 200, 'quality adds an indicator', r.j);
const kpiId = r.j.id;
const today = (await qm('/kpis')).j.today;
const m0 = prevM(today.slice(0, 7));
for (const [m, n] of [[prevM(prevM(m0)), 50], [prevM(m0), 55], [m0, 60]]) await qm('/kpis/' + kpiId + '/values', 'PUT', { period: m, num: n, den: 100 });
r = await qo('/pdsa');
const sug = r.j.suggestions.find((s) => s.source === 'kpi' && s.ref === kpiId);
check(r.s === 200 && sug && sug.baseline === 60 && sug.target === 90, 'an indicator below target 3 months is suggested', r.j.suggestions);
check((await emp('/pdsa', 'POST', { title: 'x' })).s === 403, 'an employee cannot start a project');
check((await dh('/pdsa')).j.suggestions.length === 0, 'a department head gets no suggestions');

// Quality starts the project from the suggestion: the leader and the team are told.
r = await qo('/pdsa', 'POST', { title: 'رفع الالتزام بنظافة اليدين', problem: 'الالتزام 60%', aim: '90% خلال 3 أشهر', department_id: deptA.id, leader_id: empId, team: [dhId], kpi_id: kpiId, baseline: 60, target: 90, source: 'kpi', source_ref: kpiId });
check(r.s === 200 && r.j.code === 'PDSA-001', 'quality starts a project with its code', r.j);
const pid = r.j.id;
await wait(300);
let mail = await sent();
check(mail.includes('emp@example.com') && mail.includes('dhead@example.com'), 'the leader and the team are told');
check(!(await qo('/pdsa')).j.suggestions.some((s) => s.source === 'kpi' && s.ref === kpiId), 'the suggestion goes once a project has it');
check((await boot(emp)) === 'member' && (await emp('/pdsa')).j.projects.length === 1, 'the leader sees their project');
r = await emp('/pdsa/' + pid);
check(r.s === 200 && r.j.project.kpi.values.length === 3 && r.j.project.kpi.values.every((v) => v.met === false) && r.j.project.can.cycle, 'the project shows the indicator values', r.j.project && r.j.project.kpi);
check((await dh('/pdsa/' + pid)).s === 200, 'a team member from another department sees it');

// Cycles: one at a time; done needs Study and Act.
check((await emp('/pdsa/' + pid + '/cycles', 'POST', { plan: '' })).j.error === 'pdsa_plan_required', 'a cycle needs a plan');
r = await emp('/pdsa/' + pid + '/cycles', 'POST', { plan: 'تدريب قسم الباطنة', due: plus(today, -1) });
check(r.s === 200 && r.j.n === 1, 'the leader adds cycle 1', r.j);
const c1 = r.j.id;
check((await emp('/pdsa/' + pid + '/cycles', 'POST', { plan: 'ثانية' })).j.error === 'pdsa_cycle_open', 'the next cycle waits for this one');
check((await emp('/pdsa/' + pid)).j.project.late, 'a cycle past its date makes the project late');
await sent();
await fetch(B + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('0 5 * * *'));
await wait(300);
mail = await sent();
check(mail.includes('emp@example.com') && mail.includes('qm@example.com'), 'a late cycle reminds the leader and the quality manager');
check((await emp('/pdsa/' + pid + '/cycles/' + c1, 'PUT', { do_text: 'تم', done: true })).j.error === 'pdsa_study_required', 'done needs the study and the decision');
check((await emp('/pdsa/' + pid + '/cycles/' + c1, 'PUT', { do_text: 'تم التدريب', study: 'ارتفع إلى 75%', act: 'adapt', done: true })).s === 200, 'the leader finishes cycle 1');
r = await emp('/pdsa/' + pid + '/cycles', 'POST', { plan: 'تذكير يومي' });
check(r.s === 200 && r.j.n === 2, 'cycle 2 starts', r.j);

// Finishing needs the result; then nothing more changes.
check((await emp('/pdsa/' + pid + '/close', 'POST', { status: 'done', result: 'تم' })).j.error === 'pdsa_result_required', 'finishing needs the result');
check((await emp('/pdsa/' + pid + '/close', 'POST', { status: 'done', result: 'وصل الالتزام إلى 92%' })).s === 200, 'the leader finishes the project');
check((await emp('/pdsa/' + pid + '/cycles', 'POST', { plan: 'x' })).j.error === 'pdsa_closed', 'a finished project takes no cycles');
check((await emp('/pdsa/' + pid + '/close', 'POST', { status: 'active' })).s === 403, 'only the quality manager opens it again');

// The plan: goals with their worked-out status.
const year = Number(today.slice(0, 4));
check((await dh('/plan/goals', 'POST', { year, title: 'x', quarter: 4 })).s === 403, 'a department head cannot add goals');
check((await qo('/plan/goals', 'POST', { year, title: 'x', quarter: 5 })).j.error === 'plan_bad_quarter', 'the quarter is checked');
r = await qo('/plan/goals', 'POST', { year, title: 'نظافة اليدين 90%', chapter: 'QM', quarter: 4, kpi_id: kpiId, department_id: deptB.id, owner_id: dhId });
check(r.s === 200, 'quality adds a goal tied to the indicator', r.j);
const g1 = r.j.id;
const g2 = (await qo('/plan/goals', 'POST', { year, title: 'إنجاز مشروع نظافة اليدين', quarter: 4, pdsa_id: pid, department_id: deptA.id })).j.id;
const g3 = (await qo('/plan/goals', 'POST', { year, title: 'تحديث سياسة الجودة', quarter: 1, department_id: deptA.id })).j.id;
r = await qm('/plan?year=' + year);
const st = (id) => r.j.goals.find((g) => g.id === id).status;
check(st(g1) === 'behind' && st(g2) === 'achieved' && st(g3) === (today > year + '-03-31' ? 'late' : 'on_track'), 'the status comes from the indicator, the project and the quarter', r.j.goals.map((g) => g.status));
check(r.j.plan.status === 'draft' && r.j.years.includes(year), 'the plan starts as a draft');
r = await dh('/plan?year=' + year);
check(r.j.goals.length === 1 && r.j.goals[0].id === g1 && r.j.goals[0].can_update && !r.j.goals[0].can_edit, 'a department head sees and updates their own goals');
check((await dh('/plan/goals/' + g1, 'PUT', { title: 'y' })).s === 403, 'a department head cannot edit a goal');
check((await dh('/plan/goals/' + g1 + '/progress', 'POST', { progress: 'dropped' })).s === 403, 'only quality drops a goal');
check((await dh('/plan/goals/' + g1 + '/progress', 'POST', { progress: 'done', note: 'تحقق في نوفمبر' })).s === 200, 'the department head marks it done');
r = await qm('/plan?year=' + year);
check(r.j.goals.find((g) => g.id === g1).status === 'achieved' && r.j.goals.find((g) => g.id === g1).note === 'تحقق في نوفمبر', 'the goal is achieved with its note');
check((await emp('/plan/goals/' + g3, 'PUT', { title: 'y' })).s === 404, 'others do not reach a goal');

check((await qo('/plan/approve', 'POST', { year })).s === 403, 'only the quality manager approves');
check((await qm('/plan/approve', 'POST', { year: year + 5 })).j.error === 'plan_empty', 'an empty year is not approved');
check((await qm('/plan/approve', 'POST', { year })).s === 200, 'the quality manager approves the plan');
r = await qm('/plan?year=' + year);
check(r.j.plan.status === 'approved' && r.j.plan.approved_by, 'the plan is approved', r.j.plan);

// The quality report.
check((await emp('/qreport')).s === 403, 'an employee has no quality report');
r = await qm('/qreport?period=' + m0);
check(r.s === 200 && r.j.kind === 'month' && r.j.kpis.below.some((k) => k.code === 'QP-HH') && typeof r.j.cur.ovr.n === 'number' && r.j.readiness, 'the monthly report has the indicator below target', r.j && r.j.kpis);
r = await qm('/qreport?period=' + year);
check(r.s === 200 && r.j.kind === 'year' && r.j.goals.n === 3 && r.j.goals.achieved === 2 && r.j.pdsa.done === 1, 'the yearly report counts goals and projects', r.j && { goals: r.j.goals, pdsa: r.j.pdsa });

// The monthly email is the quality report; the quality manager sends it too.
await sent();
r = await qm('/reports/mail', 'POST');
check(r.s === 200 && r.j.sent >= 1, 'the quality manager sends the report now', r.j);
{
  const v = ((await owner('/__sent')).j.find((x) => x.via === 'brevo') || { body: {} }).body;
  const html = v.htmlContent || ((v.messageVersions || [])[0] || {}).htmlContent || '';
  const subj = v.subject || ((v.messageVersions || [])[0] || {}).subject || '';
  check(/تقرير الجودة/.test(subj) && /Quality report/.test(subj) && /الشكاوى/.test(html) && /Complaints/.test(html), 'the email is the quality report in Arabic and English', subj);
}
check((await emp('/reports/mail')).s === 403, 'an employee has no report email');

// Deleting a project unlinks its goal.
check((await qo('/pdsa/' + pid, 'DELETE')).s === 403, 'only the quality manager deletes a project');
check((await qm('/pdsa/' + pid, 'DELETE')).s === 200, 'the quality manager deletes the project');
r = await qm('/plan?year=' + year);
check(r.j.goals.find((g) => g.id === g2).pdsa_id === null, 'its goal is unlinked');
check((await qm('/plan/goals/' + g3, 'DELETE')).s === 200, 'quality deletes a goal');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

// End-to-end checks for the risk register and FMEA: who sees what (quality, a department head for their own
// department, a risk owner), the level and review date, reviews, actions as CAPA, suggestions from incident
// reports, closing, deleting, and an FMEA from draft to approval. Runs after ovr2.mjs, on the same accounts.
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
  api.raw = (path) => fetch(B + '/api' + path, { headers: { cookie, 'x-requested-with': 'fetch' } });
  api.upload = async (path, name, bytes) => {
    const fd = new FormData();
    fd.set('file', new Blob([bytes], { type: 'application/pdf' }), name);
    const r = await fetch(B + '/api' + path, { method: 'POST', headers: { cookie, 'x-requested-with': 'fetch' }, body: fd });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const r = await api('/login', 'POST', { email, password });
  check(r.s === 200, 'sign in ' + email, r);
  return api;
};
const sent = async () => JSON.stringify(await (await fetch(B + '/api/__sent')).json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const owner = await login('owner@example.com', 'secret-pass-1');
const qm = await login('qm@example.com', 'secret-pass-5');
const qo = await login('qo@example.com', 'secret-pass-5');
const emp = await login('emp@example.com', 'secret-pass-5');
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
const [deptA, deptB] = depts;
check(
  (await owner('/users', 'POST', { name: 'رئيس قسم المخاطر', name_en: 'Dept head', email: 'dhead@example.com', role: 'user', password: 'secret-pass-5', quality_role: 'none', meetings_role: 'secretary', department_id: deptB.id })).s === 200,
  'owner adds a department head',
);
const dh = await login('dhead@example.com', 'secret-pass-5');
const users = (await owner('/users')).j.users;
const idOf = (email) => users.find((u) => u.email === email).id;
const [empId, dhId, qmId] = ['emp@example.com', 'dhead@example.com', 'qm@example.com'].map(idOf);
const boot = async (api) => (await api('/bootstrap')).j.user.risk;
const today = (await qm('/risk')).j.today;
await sent();

check((await boot(qm)) === 'manager' && (await boot(qo)) === 'officer' && (await boot(dh)) === 'dept' && (await boot(emp)) === 'none', 'who opens the risk system');
check((await emp('/risk', 'POST', { title: 'x', category: 'clinical', likelihood: 3, impact: 3 })).s === 403, 'an employee cannot add a risk');
check((await qo('/risk', 'POST', { title: 'x', category: 'nope', likelihood: 3, impact: 3 })).j.error === 'risk_bad_category', 'the category is checked');
check((await qo('/risk', 'POST', { title: 'x', category: 'clinical', likelihood: 6, impact: 3 })).j.error === 'risk_bad_score', 'the scores are 1 to 5');

// Quality adds a critical risk owned by the employee: the owner is told, the review is due in a month.
let r = await qo('/risk', 'POST', { title: 'سقوط المرضى في الطوارئ', category: 'patient_safety', department_id: deptA.id, chapter: 'QM', owner_id: empId, likelihood: 4, impact: 4, controls: 'تقييم خطر السقوط' });
check(r.s === 200 && r.j.code === 'RSK-001', 'quality adds a risk with its code', r.j);
const rid = r.j.id;
await wait(300);
let mail = await sent();
check(mail.includes('emp@example.com') && mail.includes('qm@example.com'), 'the owner and the quality manager (critical) are told');
r = await qo('/risk/' + rid);
check(r.j.risk.level === 'critical' && r.j.risk.score === 16 && r.j.risk.next_review === plus(today, 30) && r.j.risk.reviews.length === 1, 'level, score and review date', r.j.risk);
check((await boot(emp)) === 'member' && (await emp('/risk')).j.risks.length === 1, 'the owner sees their own risk');
check((await emp('/risk/' + rid, 'PUT', { title: 'y' })).s === 403, 'the owner cannot edit it');
check((await emp('/risk/' + rid + '/review', 'POST', { likelihood: 2, impact: 4, note: 'تم تطبيق الأساور' })).s === 200, 'the owner reviews it');
r = await qm('/risk/' + rid);
check(r.j.risk.level === 'medium' && r.j.risk.next_review === plus(today, 180) && r.j.risk.reviews.length === 2 && r.j.risk.reviews[0].note === 'تم تطبيق الأساور', 'the review lowers the level and moves the date', r.j.risk);

// Actions are CAPA.
check((await qo('/risk/' + rid + '/actions', 'POST', { title: 'تدريب الممرضين', owner: 'رئيسة التمريض', due: plus(today, 20) })).s === 200, 'quality adds an action');
const capa = (await qm('/capa')).j.capa.find((c) => c.source === 'risk');
check(capa && capa.title === 'تدريب الممرضين' && capa.chapter === 'QM' && capa.due === plus(today, 20), 'the action is a CAPA', capa);
check((await qm('/risk/' + rid)).j.risk.actions.length === 1, 'and shows on the risk');

// A department head: their own department only.
r = await dh('/risk', 'POST', { title: 'نقص الكوادر ليلًا', category: 'staff', department_id: deptA.id, likelihood: 3, impact: 2 });
check(r.s === 200, 'a department head adds a risk');
const dRisk = (await qm('/risk/' + r.j.id)).j.risk;
check(dRisk.department_id === deptB.id && dRisk.owner_id === dhId && dRisk.level === 'medium', 'it stays in their department, owned by them', dRisk);
let list = (await dh('/risk')).j.risks;
check(list.length === 1 && list[0].id === dRisk.id, 'the department head sees only their department');
check((await dh('/risk/' + rid)).s === 404 && (await dh('/risk/' + rid + '/actions', 'POST', { title: 'x' })).s === 404, 'and cannot open another department’s risk');
check((await qo('/risk/' + dRisk.id, 'PUT', { likelihood: 5, impact: 4 })).s === 200 && (await qm('/risk/' + dRisk.id)).j.risk.reviews.length === 2, 'a change of rating is kept as a review');

// The register's figures and the heat map.
r = await qm('/risk/report');
check(r.s === 200 && r.j.grid[1][3] === 1 && r.j.grid[4][3] === 1 && r.j.top[0].id === dRisk.id, 'the heat map counts open risks', r.j);
check((await dh('/risk/report')).s === 403, 'only quality reads the full report');
const home = (await qm('/home')).j;
check(home.risk && home.risk.open === 2 && home.risk.critical === 1, 'the home card counts them', home.risk);

// Suggestions: three reports of one type in 90 days with no open risk.
const meta = (await qm('/ovr/cats')).j.categories;
const top = meta.find((c) => !c.parent_id && meta.some((s) => s.parent_id === c.id && !s.sentinel));
const sub = meta.find((s) => s.parent_id === top.id && !s.sentinel);
for (let i = 0; i < 3; i++)
  check((await emp.form('/public/ovr', { occurred_at: today + 'T10:00', department_id: String(deptA.id), category_id: String(top.id), sub_id: String(sub.id), harm: 'no_harm', description: 'بلاغ تجريبي للمخاطر ' + i })).s === 200, 'a report of the same type ' + (i + 1));
let sug = (await qo('/risk')).j.suggestions;
check(sug.some((s) => s.id === top.id && s.n >= 3), 'repeated reports suggest a risk', sug);
r = await qo('/risk', 'POST', { title: 'خطر من البلاغات', category: 'clinical', likelihood: 2, impact: 2, ovr_cat_id: top.id });
check(r.s === 200 && (await qm('/risk/' + r.j.id)).j.risk.level === 'low', 'adding it from the suggestion');
sug = (await qo('/risk')).j.suggestions;
check(!sug.some((s) => s.id === top.id), 'the suggestion goes once the risk exists');
check((await dh('/risk')).j.suggestions.length === 0, 'suggestions are for quality only');

// Review reminders: a late review tells the owner and the quality managers once.
await qm('/risk/' + rid, 'PUT', {});
await fetch(B + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('0 5 * * *'));
await wait(300);
await sent();

// Closing and deleting.
check((await qo('/risk/' + dRisk.id + '/close', 'POST', { closed: true })).s === 200 && (await qm('/risk/' + dRisk.id)).j.risk.status === 'closed', 'quality closes a risk');
check((await qo('/risk/' + dRisk.id + '/review', 'POST', { likelihood: 1, impact: 1 })).j.error === 'risk_closed', 'a closed risk takes no review');
check((await qo('/risk/' + rid, 'DELETE')).s === 403, 'a quality officer cannot delete');
check((await qm('/risk/' + rid, 'DELETE')).s === 200 && !(await qm('/capa')).j.capa.some((c) => c.source === 'risk'), 'the quality manager deletes it with its actions');

// FMEA: a team, the worksheet, approval opens the actions, then the scores after.
r = await qo('/risk/fmea', 'POST', { title: 'إعطاء الأدوية عالية الخطورة', process: 'من الوصفة حتى الإعطاء', department_id: deptA.id, team: [empId] });
check(r.s === 200, 'quality starts an FMEA');
const fid = r.j.id;
await wait(300);
check((await sent()).includes('emp@example.com'), 'the team is told');
check((await boot(emp)) === 'member', 'a team member opens the system');
const steps = [
  { step: 'كتابة الوصفة', modes: [{ mode: 'جرعة خاطئة', effect: 'جرعة زائدة', cause: 'لا يوجد تنبيه', controls: 'مراجعة الصيدلي', s: 9, o: 4, d: 5, action: 'تنبيه الجرعة القصوى', owner_id: qmId, due: plus(today, 30) }] },
  { step: 'الإعطاء', modes: [{ mode: 'مريض خاطئ', effect: 'ضرر', cause: 'عدم التحقق', s: 8, o: 2, d: 3 }] },
];
check((await emp('/risk/fmea/' + fid, 'PUT', { steps })).s === 200, 'a team member fills the worksheet');
let f = (await qm('/risk/fmea/' + fid)).j.fmea;
check(f.steps.length === 2 && f.n_modes === 2 && f.max_rpn === 180 && f.n_high === 1, 'the RPN is worked out', f);
check((await dh('/risk/fmea')).j.fmea.length === 0, 'a department head sees other departments’ studies only if in the team');
check((await qo('/risk/fmea/' + fid + '/approve', 'POST')).s === 403, 'a quality officer cannot approve');
const bad = JSON.parse(JSON.stringify(steps));
bad[1].modes[0].action = 'لافتة';
await qo('/risk/fmea/' + fid, 'PUT', { steps: bad });
check((await qm('/risk/fmea/' + fid + '/approve', 'POST')).j.error === 'fmea_action_owner', 'each action needs an owner and a date');
await qo('/risk/fmea/' + fid, 'PUT', { steps });
r = await qm('/risk/fmea/' + fid + '/approve', 'POST');
check(r.s === 200 && r.j.actions === 1, 'approval opens the actions', r.j);
f = (await qm('/risk/fmea/' + fid)).j.fmea;
check(f.status === 'approved' && f.actions.length === 1 && (await qm('/capa')).j.capa.some((c) => c.source === 'fmea' && c.title === 'تنبيه الجرعة القصوى'), 'as CAPA', f.actions);
const after = JSON.parse(JSON.stringify(f.steps));
after[0].modes[0] = { ...after[0].modes[0], mode: 'تغيير', s2: 9, o2: 1, d2: 2 };
check((await emp('/risk/fmea/' + fid, 'PUT', { steps: after })).s === 200, 'the scores after the action are recorded');
f = (await qm('/risk/fmea/' + fid)).j.fmea;
check(f.steps[0].modes[0].mode === 'جرعة خاطئة' && f.steps[0].modes[0].s2 === 9 && f.max_rpn2 === 48, 'only the scores after change once approved', f.steps[0].modes[0]);
check((await qm('/risk/fmea/' + fid, 'DELETE')).s === 200 && !(await qm('/capa')).j.capa.some((c) => c.source === 'fmea'), 'deleting the study removes its actions');

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

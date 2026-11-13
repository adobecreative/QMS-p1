// End-to-end checks for complaints and the satisfaction survey: the public form and survey, the tracking link,
// sending for a reply, the reply, closing with what the patient is told, reminders, the report, the settings
// and the two automatic indicators. Runs after risk.mjs, on the same accounts.
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
const users = (await owner('/users')).j.users;
const empId = users.find((u) => u.email === 'emp@example.com').id;
const boot = async (api) => (await api('/bootstrap')).j.user.pex;
const pub = async (path, method = 'GET', body) => {
  const r = await fetch(B + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
  return { s: r.status, j: await r.json().catch(() => null) };
};
await sent();

check((await boot(qm)) === 'manager' && (await boot(qo)) === 'officer' && (await boot(emp)) === 'none', 'who opens complaints');
const meta = (await pub('/public/pex/form')).j;
check(meta.questions.length === 6 && meta.kinds.length === 3, 'the survey starts with six questions', meta.questions.length);
const dept = meta.departments[0].id;

// A complaint from the QR code: name and mobile needed.
check((await pub('/public/pex', 'POST', { kind: 'complaint', description: 'انتظرت ثلاث ساعات', department_id: dept })).j.error === 'pex_contact_required', 'a complaint needs a name and mobile');
check((await pub('/public/pex', 'POST', { kind: 'complaint', description: 'انتظرت ثلاث ساعات', patient_name: 'سالم', phone: 'abc', department_id: dept })).j.error === 'pex_bad_phone', 'the mobile is checked');
let r = await pub('/public/pex', 'POST', { kind: 'complaint', category: 'waiting', description: 'انتظرت ثلاث ساعات في العيادة', patient_name: 'سالم', phone: '0501234567', patient_mrn: 'MRN-1', department_id: dept });
check(r.s === 200 && r.j.id > 0 && /^[0-9a-f]{32}$/.test(r.j.track), 'a patient sends a complaint and gets a tracking link', r.j);
const cid = r.j.id;
const track = r.j.track;
await wait(300);
let mail = await sent();
check(mail.includes('qm@example.com') && mail.includes('qo@example.com') && !mail.includes('سالم'), 'quality is told, without the patient’s name');
check((await pub('/public/pex/' + cid + '?k=' + track)).j.pex.status === 'new', 'the tracking link shows where it stands');
check((await pub('/public/pex/' + cid + '?k=' + 'a'.repeat(32))).s === 404, 'a wrong link shows nothing');
check((await pub('/public/pex', 'POST', { kind: 'praise', description: 'شكرًا لطاقم التمريض' })).s === 200, 'thanks need no name');
check((await pub('/public/pex', 'POST', { kind: 'suggestion', description: 'مواقف أكثر', website: 'x' })).j.id === 0, 'a bot is ignored');

// Quality sends it for a reply; the person replies; quality closes it with what the patient is told.
r = await qo('/pex/' + cid);
check(r.j.pex.patient_name === 'سالم' && r.j.pex.phone === '0501234567' && r.j.pex.can.route, 'quality sees the contact details');
check((await emp('/pex/' + cid)).s === 404, 'an employee cannot open it');
check((await qo('/pex/' + cid + '/route', 'POST', { user_id: empId, note: 'نرجو الرد' })).s === 200, 'quality sends it for a reply');
await wait(300);
check((await sent()).includes('emp@example.com'), 'the person is told');
check((await boot(emp)) === 'member' && (await emp('/pex')).j.pex.length === 1, 'they see what was sent to them');
check((await emp('/pex/' + cid + '/close', 'POST', { resolution: 'x' })).s === 403, 'they cannot close it');
check((await emp('/pex/' + cid + '/reply', 'POST', { reply: 'تم تعديل جدول المواعيد' })).s === 200, 'they reply');
check((await qm('/pex/' + cid)).j.pex.status === 'replied', 'it goes back to quality');
check((await qo('/pex/' + cid + '/close', 'POST', {})).j.error === 'pex_resolution_required', 'closing a complaint needs what the patient is told');
check((await qo('/pex/' + cid + '/close', 'POST', { resolution: 'نعتذر، تم تعديل المواعيد' })).s === 200, 'quality closes it');
r = await pub('/public/pex/' + cid + '?k=' + track);
check(r.j.pex.status === 'closed' && r.j.pex.resolution === 'نعتذر، تم تعديل المواعيد', 'the patient sees the reply', r.j);
check((await qo('/pex/' + cid + '/close', 'POST', { reopen: true })).s === 403 && (await qm('/pex/' + cid + '/close', 'POST', { reopen: true })).s === 200 && (await qm('/pex/' + cid)).j.pex.status === 'replied', 'only the quality manager reopens');
check((await qo('/pex/' + cid + '/close', 'POST', { resolution: 'تم الحل' })).s === 200, 'and it closes again');

// A late reply reminds the person once a day.
r = await pub('/public/pex', 'POST', { kind: 'complaint', category: 'staff', description: 'تعامل غير لائق', patient_name: 'منى', phone: '0559999999', department_id: dept });
const c2 = r.j.id;
await qo('/pex/' + c2 + '/route', 'POST', { user_id: empId });
await sent();

// The survey: no name, answers 1-5.
const qs = meta.questions;
check((await pub('/public/pex/survey', 'POST', { answers: {} })).j.error === 'pex_no_answers', 'a survey needs an answer');
check((await pub('/public/pex/survey', 'POST', { department_id: dept, answers: Object.fromEntries(qs.map((q) => [q.id, 5])), comment: 'ممتاز' })).s === 200, 'a patient fills the survey');
check((await pub('/public/pex/survey', 'POST', { answers: { [qs[0].id]: 2, [qs[1].id]: 4, [qs[2].id]: 9 } })).s === 200, 'a value out of range is left out');
r = await qm('/pex/report');
check(r.s === 200 && r.j.totals.responses === 2 && r.j.totals.answers === 8 && r.j.totals.satisfied === 7 && r.j.totals.complaints === 2 && r.j.totals.closed === 1, 'the report counts', r.j.totals);
const q0 = r.j.questions.find((q) => q.id === qs[0].id);
check(q0.n === 2 && q0.avg === 3.5 && q0.pct === 50, 'per question: average and share of 4-5', q0);
check((await emp('/pex/report')).s === 403, 'only quality reads the report');
const home = (await qm('/home')).j;
check(home.pex && home.pex.open === 1, 'the home card counts open complaints', home.pex);

// Settings: deadlines and questions.
check((await qo('/pex/settings')).s === 403, 'only the quality manager changes the settings');
check((await qm('/pex/settings', 'PUT', { reply_days: 5, close_days: 20 })).s === 200 && (await qm('/pex/settings')).j.reply_days === 5, 'the deadlines change');
check((await qm('/pex/settings/questions', 'POST', { text_ar: 'سؤال جديد', text_en: 'New question' })).s === 200, 'a question is added');
const all = (await qm('/pex/settings')).j.questions;
const added = all.find((q) => q.text_en === 'New question');
check((await qm('/pex/settings/questions/' + qs[0].id, 'DELETE')).j.error === 'pex_q_used', 'a question with answers cannot be deleted');
check((await qm('/pex/settings/questions/' + qs[0].id, 'PUT', { active: false })).s === 200 && !(await pub('/public/pex/form')).j.questions.some((q) => q.id === qs[0].id), 'but can be turned off');
check((await qm('/pex/settings/questions/' + added.id, 'DELETE')).s === 200, 'an unused question is deleted');

// The automatic indicators.
check((await qm('/kpis/library', 'POST', { codes: ['QM-SAT', 'QM-CMP'] })).s === 200, 'the satisfaction and complaints indicators come from the library');
await fetch(B + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('0 5 * * *'));
await wait(300);
const ks = (await qm('/kpis')).j.kpis.filter((k) => k.code === 'QM-SAT' || k.code === 'QM-CMP');
const sat = ks.find((k) => k.code === 'QM-SAT');
check(ks.every((k) => k.source !== 'manual') && sat.values.some((v) => v.num === 7 && v.den === 8), 'satisfaction is worked out from the survey', ks.map((k) => [k.code, k.source, k.values]));
check((await qm('/pex/' + c2, 'DELETE')).s === 200, 'the quality manager deletes a record');

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

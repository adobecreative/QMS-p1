// End-to-end checks for investigations: settings and penalties, who sees what (officers, committee, the person
// investigated, witnesses), questions and answers, files, the minutes, the right of reply, the decision and its return,
// and the investigation opened for repeated committee absences. Runs after ovr2.mjs, on the same data and accounts.

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
// Working days in Saudi Arabia: Friday and Saturday off.
const plusWork = (d, n) => {
  let x = d;
  while (n > 0) {
    x = new Date(Date.parse(x + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const w = new Date(x + 'T00:00:00Z').getUTCDay();
    if (w !== 5 && w !== 6) n--;
  }
  return x;
};

const owner = await login('owner@example.com', 'secret-pass-1');
const qm = await login('qm@example.com', 'secret-pass-5');
const qo = await login('qo@example.com', 'secret-pass-5');
const emp = await login('emp@example.com', 'secret-pass-5');
const head = await login('head@example.com', 'secret-pass-5');
const hr = await login('hr@example.com', 'secret-pass-5');
const users = (await owner('/users')).j.users;
const idOf = (email) => users.find((u) => u.email === email).id;
const [qoId, empId, headId, hrId] = ['qo@example.com', 'emp@example.com', 'head@example.com', 'hr@example.com'].map(idOf);
const bootInv = async (api) => (await api('/bootstrap')).j.user.inv;
await sent();

// Who can open it: quality managers; the approver once named. A quality officer or an employee cannot.
check((await bootInv(qm)) === 'manager' && (await bootInv(emp)) === 'none' && (await bootInv(qo)) === 'none', 'the quality manager runs investigations; others do not see the system');
check((await qo('/inv', 'POST', { title: 'x', subject_user_id: empId })).s === 403, 'a quality officer cannot open an investigation');
check((await emp('/inv')).j.invs.length === 0, 'an employee sees none');
const pens = (await qm('/inv/penalties')).j.penalties;
const deduction = pens.find((p) => p.name_en === 'Salary deduction');
const warning = pens.find((p) => p.name_en === 'Written warning');
check(pens.length === 6 && deduction.days === 1 && warning.days === 0, 'the starter penalties are there, the deduction in days', pens);

// Settings: the human resources manager approves; deadlines in working days.
check((await qo('/inv/settings')).s === 403, 'a quality officer cannot open the settings');
check((await qm('/inv/settings', 'PUT', { approver: hrId, staff: [], answer_days: 0, minutes_days: 5, decision_days: 3, absence_after: 2 })).j.error === 'inv_bad_days', 'deadlines are checked');
check((await qm('/inv/settings', 'PUT', { approver: 999999, staff: [], answer_days: 2, minutes_days: 5, decision_days: 3, absence_after: 2 })).j.error === 'inv_bad_person', 'the approver must be an active account');
check((await qm('/inv/settings', 'PUT', { approver: hrId, staff: [], answer_days: 2, minutes_days: 5, decision_days: 3, absence_after: 2 })).s === 200, 'the quality manager names the human resources manager as approver');
let r = await hr('/inv/settings');
check(r.s === 200 && r.j.approver === hrId && r.j.answer_days === 2 && r.j.minutes_days === 5 && r.j.decision_days === 3 && r.j.absence_after === 2, 'the approver opens the settings and they are kept', r.j);
check((await bootInv(hr)) === 'manager', 'the approver runs investigations too');
check((await hr('/inv/penalties', 'POST', { name_ar: 'Notice', name_en: 'x' })).j.error === 'name_ar_latin', 'a penalty name is checked');
r = await hr('/inv/penalties', 'POST', { name_ar: 'خصم تجريبي', name_en: 'Test deduction', days: true });
check(r.s === 200, 'the approver adds a penalty');
check((await hr('/inv/penalties/' + r.j.id, 'DELETE')).s === 200, 'and removes it while unused');

// Open one: the employee investigated, the department head heads the committee.
check((await qm('/inv', 'POST', { title: 'تأخر متكرر', subject_user_id: empId, head_id: empId })).j.error === 'inv_subject_in_committee', 'the person investigated cannot sit on the committee');
check((await qm('/inv', 'POST', { title: '', subject_user_id: empId })).j.error === 'inv_title_required', 'the subject is needed');
r = await qm('/inv', 'POST', { title: 'تأخر متكرر عن الدوام', details: 'تأخر 5 مرات خلال الشهر', requested_by: 'مدير القسم', subject_user_id: empId, head_id: headId, members: [qoId] });
check(r.s === 200, 'the quality manager opens an investigation', r.j);
const id1 = r.j.id;
const today = (await qm('/inv')).j.today;
r = await qm('/inv/' + id1);
let inv = r.j.inv;
check(inv.status === 'open' && inv.minutes_due === plusWork(today, 5) && inv.committee.length === 2 && inv.subject_name === 'موظف مبلغ' && inv.department_id, 'it is open, the minutes due in 5 working days, with its committee and the person', inv);
let mail = await sent();
check(mail.includes('head@example.com') && mail.includes('qo@example.com') && !mail.includes('emp@example.com') && !mail.includes('تأخر متكرر'), 'the committee is told, without the subject in the email');
check((await bootInv(emp)) === 'member' && (await bootInv(head)) === 'member', 'the person and the committee now see the system');

// What the person sees: the case and their own questions, never the committee's work.
r = await emp('/inv/' + id1);
check(r.j.inv.part === 'subject' && r.j.inv.title && r.j.inv.committee === undefined && r.j.inv.steps === undefined && r.j.inv.facts === undefined, 'the person sees the case, not the committee or its notes', r.j.inv);

// Questions: to the person, to a witness with an account and to one without.
check((await head('/inv/' + id1 + '/questions', 'POST', { to: 'subject', questions: [] })).j.error === 'inv_question_required', 'a question is needed');
r = await head('/inv/' + id1 + '/questions', 'POST', { to: 'subject', questions: ['ما سبب التأخر؟', 'هل أبلغت مديرك؟'] });
check(r.s === 200 && r.j.due === plusWork(today, 2), 'the committee head asks the person two questions, due in 2 working days', r.j);
check((await head('/inv/' + id1 + '/questions', 'POST', { to: hrId, questions: ['هل وصلك إشعار بالتأخر؟'] })).s === 200, 'and a witness with an account');
check((await head('/inv/' + id1 + '/questions', 'POST', { to: '', to_name: 'حارس البوابة', questions: ['متى وصل الموظف؟'] })).s === 200, 'and a witness without one');
mail = await sent();
check(mail.includes('emp@example.com') && mail.includes('hr@example.com'), 'the person and the witness are told');
check((await emp('/inv/' + id1 + '/questions', 'POST', { to: 'subject', questions: ['x'] })).s === 403, 'the person cannot ask');
inv = (await head('/inv/' + id1)).j.inv;
const qs = inv.questions;
const mine = (await emp('/inv/' + id1)).j.inv.questions;
check(qs.length === 4 && mine.length === 2 && mine.every((q) => q.to_user_id === empId), 'the committee sees every question, the person only theirs');
// A witness with no part in the case sees only their own questions; the list shows no title.
const asWitness = (await qo('/inv')).j.invs.find((x) => x.id === id1);
check(asWitness && asWitness.part === 'member', 'a committee member sees it in their list');
// hr is the approver (officer); use a fresh witness: the department head of another case is tested below.

// Answers.
const [q1, q2] = mine;
check((await emp('/inv/' + id1 + '/questions/' + q1.id, 'POST', { answer: '' })).j.error === 'inv_answer_required', 'an answer is needed');
check((await head('/inv/' + id1 + '/questions/' + q1.id, 'POST', { answer: 'x' })).s === 403, 'nobody else answers for the person');
check((await emp('/inv/' + id1 + '/questions/' + q1.id, 'POST', { answer: 'ظروف المواصلات' })).s === 200, 'the person answers');
await sent();
check((await emp('/inv/' + id1 + '/questions/' + q2.id, 'POST', { answer: 'نعم أبلغته' })).s === 200, 'and answers the second');
mail = await sent();
check(mail.includes('head@example.com'), 'once all are answered, the committee is told');
check((await emp('/inv/' + id1 + '/questions/' + q1.id, 'POST', { answer: 'تعديل' })).j.error === 'inv_answered', 'an answer stays as given');
const off = qs.find((q) => q.to_user_id === null);
check((await emp('/inv/' + id1 + '/questions/' + off.id, 'POST', { answer: 'x' })).s === 403, 'the person cannot write a witness answer');
check((await head('/inv/' + id1 + '/questions/' + off.id, 'POST', { answer: 'وصل 8:40' })).s === 200, 'the committee records what the witness without an account said');
r = await head('/inv/' + id1);
check(r.j.inv.questions.find((q) => q.id === off.id).answered_by === 'رئيس القسم', 'and who recorded it is kept');

// Files: the person adds one; the committee sees it; the person sees only their own.
const pdf = new TextEncoder().encode('%PDF-1.4\n%test\n');
check((await emp.upload('/inv/' + id1 + '/files', 'excuse.pdf', pdf)).s === 200, 'the person attaches a file');
check((await head.upload('/inv/' + id1 + '/files', 'attendance.pdf', pdf)).s === 200, 'the committee attaches the attendance record');
check((await emp.upload('/inv/' + id1 + '/files', 'bad.exe', pdf)).j.error === 'mtg_file_type', 'only document and picture files');
const files = (await head('/inv/' + id1)).j.inv.files;
const empFiles = (await emp('/inv/' + id1)).j.inv.files;
check(files.length === 2 && empFiles.length === 1 && empFiles[0].name === 'excuse.pdf', 'the committee sees both files, the person only theirs');
const other = files.find((f) => f.name === 'attendance.pdf');
check((await emp.raw('/inv/' + id1 + '/files/' + other.id)).status === 404 && (await head.raw('/inv/' + id1 + '/files/' + empFiles[0].id)).status === 200, 'the person cannot open the committee file; the committee opens theirs');

// Minutes: questions still within their time hold them back.
const hrQ = qs.find((q) => q.to_user_id === hrId);
check((await head('/inv/' + id1 + '/minutes', 'PUT', { facts: 'تأخر 5 مرات', finding: 'ثبتت المخالفة', rec_outcome: 'penalty', rec_penalty_id: deduction.id, rec_days: 1, submit: true })).j.error === 'inv_questions_open', 'unanswered questions in their time hold the minutes back');
check((await head('/inv/' + id1 + '/questions/' + hrQ.id, 'DELETE')).s === 200, 'the committee takes back the witness question');
check((await head('/inv/' + id1 + '/minutes', 'PUT', { facts: 'تأخر 5 مرات', submit: true })).j.error === 'inv_minutes_required', 'facts and finding are needed');
check((await head('/inv/' + id1 + '/minutes', 'PUT', { facts: 'تأخر 5 مرات', finding: 'ثبتت', rec_outcome: 'penalty', rec_penalty_id: deduction.id, submit: true })).j.error === 'inv_bad_penalty_days', 'a deduction needs its days');
check((await head('/inv/' + id1 + '/minutes', 'PUT', { facts: 'مسودة', finding: '' })).s === 200, 'a draft is saved');
check((await emp('/inv/' + id1)).j.inv.facts === undefined, 'the person does not see a draft');
await sent();
r = await head('/inv/' + id1 + '/minutes', 'PUT', { facts: 'تأخر 5 مرات خلال الشهر', finding: 'ثبتت المخالفة', rec_outcome: 'penalty', rec_penalty_id: deduction.id, rec_days: 1, submit: true });
check(r.s === 200 && r.j.status === 'reply', 'the minutes go to the person for their reply', r.j);
mail = await sent();
check(mail.includes('emp@example.com'), 'the person is told');
inv = (await emp('/inv/' + id1)).j.inv;
check(inv.facts === 'تأخر 5 مرات خلال الشهر' && inv.rec_days === 1 && inv.reply_due === plusWork(today, 2) && inv.can.reply, 'the person reads the minutes and may reply', inv);
check((await head('/inv/' + id1 + '/minutes', 'PUT', { facts: 'x', finding: 'y' })).j.error === 'inv_not_open', 'the minutes cannot change once sent');
check((await hr('/inv/' + id1 + '/decide', 'POST', { outcome: 'cleared' })).j.error === 'inv_not_decision', 'no decision before the reply or its deadline');

// Right of reply.
check((await head('/inv/' + id1 + '/reply', 'POST', { reply: 'x' })).s === 403, 'only the person replies');
check((await emp('/inv/' + id1 + '/reply', 'POST', { reply: 'أعتذر وسألتزم' })).s === 200, 'the person replies to the minutes');
mail = await sent();
check(mail.includes('hr@example.com'), 'the approver is told a decision is waiting');
inv = (await hr('/inv/' + id1)).j.inv;
check(inv.status === 'decision' && inv.reply === 'أعتذر وسألتزم' && inv.decision_due === plusWork(today, 3) && inv.can.decide, 'it waits for the decision, due in 3 working days', inv);
check((await bootInv(emp)) === 'member' && (await qm('/inv/' + id1)).j.inv.can.decide === false, 'with an approver named, the quality manager does not decide');

// Decision.
check((await qm('/inv/' + id1 + '/decide', 'POST', { outcome: 'cleared' })).s === 403, 'the quality manager cannot decide');
check((await hr('/inv/' + id1 + '/decide', 'POST', { outcome: 'penalty', penalty_id: deduction.id })).j.error === 'inv_bad_penalty_days', 'the decision checks the days');
check((await hr('/inv/' + id1 + '/decide', 'POST', { outcome: 'penalty', penalty_id: warning.id, note: 'إنذار مع التنبيه' })).s === 200, 'the human resources manager decides a written warning');
mail = await sent();
check(mail.includes('emp@example.com') && mail.includes('head@example.com') && mail.includes('qm@example.com') && !mail.includes('إنذار'), 'the person, committee and opener are told, without the penalty in the email');
inv = (await emp('/inv/' + id1)).j.inv;
check(inv.status === 'closed' && inv.outcome === 'penalty' && inv.pen_en === 'Written warning' && inv.decided_by === 'الموارد البشرية', 'the person sees the decision', inv);
check((await emp.upload('/inv/' + id1 + '/files', 'late.pdf', pdf)).j.error === 'inv_closed', 'nothing is added once closed');
check((await hr('/inv/penalties/' + warning.id, 'DELETE')).j.error === 'inv_pen_used', 'a penalty in use cannot be deleted');

// Someone without an account: the minutes go straight to the decision; the approver can return them.
r = await qm('/inv', 'POST', { title: 'مخالفة سلوك', subject_name: 'متعاقد خارجي', subject_emp_no: '٤٥٦', head_id: headId });
const id2 = r.j.id;
inv = (await qm('/inv/' + id2)).j.inv;
check(inv.subject_user_id === null && inv.subject_emp_no === '456', 'a person without an account, the number in Western digits', inv);
check((await head('/inv/' + id2 + '/questions', 'POST', { to: 'subject', questions: ['ما أقوالك؟'] })).s === 200, 'questions to them are recorded by the committee');
const q3 = (await head('/inv/' + id2)).j.inv.questions[0];
check(q3.to_user_id === null && (await head('/inv/' + id2 + '/questions/' + q3.id, 'POST', { answer: 'لم أقصد' })).s === 200, 'the committee writes their answer');
r = await head('/inv/' + id2 + '/minutes', 'PUT', { facts: 'وقائع', finding: 'لم تثبت', rec_outcome: 'cleared', submit: true });
check(r.j.status === 'decision', 'with no account the minutes go straight to the decision', r.j);
check((await hr('/inv/' + id2 + '/return', 'POST', { note: '' })).j.error === 'ovr_note_required', 'returning needs a note');
check((await hr('/inv/' + id2 + '/return', 'POST', { note: 'استكمل أقوال الشهود' })).s === 200, 'the approver returns the minutes');
inv = (await head('/inv/' + id2)).j.inv;
check(inv.status === 'open' && inv.can.minutes && inv.minutes_at === null && inv.facts === 'وقائع', 'the committee has them back to complete', inv);
await head('/inv/' + id2 + '/minutes', 'PUT', { facts: 'وقائع كاملة', finding: 'لم تثبت', rec_outcome: 'cleared', submit: true });
check((await hr('/inv/' + id2 + '/decide', 'POST', { outcome: 'cleared' })).s === 200 && (await qm('/inv/' + id2)).j.inv.outcome === 'cleared', 'and it closes as not proven');

// A witness with an account sees only the questions put to them.
r = await qm('/inv', 'POST', { title: 'شكوى', subject_user_id: headId, head_id: qoId });
const id3 = r.j.id;
await qo('/inv/' + id3 + '/questions', 'POST', { to: empId, questions: ['هل شاهدت الواقعة؟'] });
r = await emp('/inv/' + id3);
check(r.j.inv.part === 'witness' && r.j.inv.title === undefined && r.j.inv.subject_name === undefined && r.j.inv.questions.length === 1, 'a witness sees only their question', r.j.inv);
const wl = (await emp('/inv')).j.invs.find((x) => x.id === id3);
check(wl && wl.title === undefined && wl.my_questions === 1, 'and the list shows them only that questions wait');
check((await emp('/inv/' + id3 + '/minutes', 'PUT', { facts: 'x' })).s === 403, 'a witness cannot write the minutes');
check((await head('/inv/' + id3)).j.inv.part === 'subject', 'the person investigated in that case is the subject there');
check((await emp('/inv/' + id3 + '/questions', 'GET')).s !== 200, 'nothing else opens for the witness');
check((await qo('/inv/' + id3, 'DELETE')).s === 403 && (await qm('/inv/' + id3, 'DELETE')).s === 200, 'only a manager deletes an investigation');

// Committee absences: two unexcused absences in a row open an investigation, with a question to the member.
r = await owner('/committees', 'POST', { name_ar: 'لجنة الانضباط', name_en: 'Discipline Committee', frequency: 'monthly', first_date: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10), start_time: '10:00', duration_min: 60, quorum_pct: 50 });
const cid = r.j.id;
await owner('/committees/' + cid + '/members', 'POST', { name: 'رئيس القسم', email: 'head@example.com', role: 'chair' });
await owner('/committees/' + cid + '/members', 'POST', { name: 'موظف مبلغ', email: 'emp@example.com', role: 'member' });
const members = (await owner('/committees/' + cid)).j.members;
const absentM = members.find((m) => m.email === 'emp@example.com');
const meet = async (time, status = 'absent') => {
  await owner('/committees/' + cid + '/sessions', 'POST', { date: today, start_time: time, reason: 'اختبار' });
  const ses = (await owner('/committees/' + cid)).j.sessions.find((x) => x.date === today && x.start_time === time);
  const attendance = members.map((m) => ({ member_id: m.id, status: m.id === absentM.id ? status : 'present' }));
  await owner('/committee-sessions/' + ses.id + '/minutes', 'PUT', { submit: true, items: [{ subject: 'افتتاح' }], attendance });
  return { ses, approve: await owner('/committee-sessions/' + ses.id + '/minutes/approve', 'POST') };
};
const absences = async () => (await qm('/inv')).j.invs.filter((x) => x.source === 'absence');
const before = (await absences()).length;
const ovrBefore = (await qm('/ovr')).j.ovr.filter((o) => o.source === 'system').length;
check((await meet('06:00')).approve.s === 200, 'the first minutes with the member absent are approved');
await wait(800);
check((await absences()).length === before, 'one absence opens nothing');
await sent();
const m2 = await meet('06:30');
check(m2.approve.s === 200, 'the second minutes with the member absent again are approved');
let found = [];
for (let i = 0; i < 20 && !found.length; i++) {
  await wait(300);
  found = (await absences()).slice(0, (await absences()).length - before);
}
const abs = found[0];
check(abs && abs.title.includes('Committee absence') && abs.subject_name === 'موظف مبلغ', 'two absences in a row open an investigation', abs);
check((await qm('/ovr')).j.ovr.filter((o) => o.source === 'system').length === ovrBefore, 'and no incident report');
inv = (await qm('/inv/' + abs.id)).j.inv;
check(inv.details.includes('لجنة الانضباط') && inv.details.includes('2') && inv.subject_user_id === empId && inv.questions.length === 1 && inv.questions[0].to_user_id === empId, 'with the committee, the count, and a question to the member', inv);
mail = await sent();
check(mail.includes('hr@example.com') && mail.includes('qm@example.com') && mail.includes('emp@example.com'), 'human resources, quality and the member are told');
const absQ = (await emp('/inv/' + abs.id)).j.inv.questions[0];
check((await emp('/inv/' + abs.id + '/questions/' + absQ.id, 'POST', { answer: 'كنت في مناوبة' })).s === 200, 'the member answers why');
await owner('/committee-sessions/' + m2.ses.id + '/minutes/reopen', 'POST');
await owner('/committee-sessions/' + m2.ses.id + '/minutes', 'PUT', { submit: true, items: [{ subject: 'افتتاح' }], attendance: members.map((m) => ({ member_id: m.id, status: m.id === absentM.id ? 'absent' : 'present' })) });
await owner('/committee-sessions/' + m2.ses.id + '/minutes/approve', 'POST');
await wait(800);
check((await absences()).length === before + 1, 'approving the same minutes again does not repeat it');
await qm('/inv/settings', 'PUT', { approver: hrId, staff: [], answer_days: 2, minutes_days: 5, decision_days: 3, absence_after: 1 });
check((await meet('07:00', 'excused')).approve.s === 200, 'minutes with an excused absence are approved');
await wait(800);
check((await absences()).length === before + 1, 'an excused absence opens nothing');
await qm('/inv/settings', 'PUT', { approver: hrId, staff: [], answer_days: 2, minutes_days: 5, decision_days: 3, absence_after: 0 });

// Home numbers, and human resources staff named in the settings.
r = await hr('/home');
check(r.j.inv && r.j.inv.open >= 1, 'the home page shows open investigations to the approver', r.j.inv);
r = await emp('/home');
check(r.j.inv && r.j.inv.questions === 0 && r.j.inv.reply === 0, 'and the person their own numbers', r.j.inv);
await qm('/inv/settings', 'PUT', { approver: hrId, staff: [qoId], answer_days: 2, minutes_days: 5, decision_days: 3, absence_after: 0 });
check((await bootInv(qo)) === 'officer' && (await qo('/inv')).j.invs.length >= 2, 'human resources staff named in the settings see every investigation');
check((await qo('/inv/settings')).s === 403, 'but not the settings');

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

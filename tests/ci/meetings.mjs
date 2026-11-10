// End-to-end checks for Committees & meetings: the committees master, members, papers, the schedule made
// from the frequency, moving/postponing/cancelling a session, and the invitations and reminders.
// Runs after quality.mjs, on the same data. Each check prints PASS or FAIL; any FAIL makes the run fail.

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
  api.form = async (path, method, fd) => {
    const r = await fetch(B + '/api' + path, { method, headers: { cookie, 'x-requested-with': 'fetch' }, body: fd });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  api.raw = (path) => fetch(B + '/api' + path, { headers: { cookie, 'x-requested-with': 'fetch' } });
  const r = await api('/login', 'POST', { email, password });
  check(r.s === 200, 'sign in ' + email, r);
  return api;
};
const sent = async () => (await (await fetch(B + '/api/__sent')).json()).filter((m) => JSON.stringify(m).includes('meeting'));
const cron = (cronExpr) => fetch(B + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent(cronExpr));
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const owner = await login('owner@example.com', 'secret-pass-1');
const tech = await login('tech@example.com', 'secret-pass-2');
let r;

// Email through Brevo, so what is sent can be read back.
await owner('/settings', 'PUT', { mail_provider: 'brevo', brevo_key: 'test-key', mail_from: 'qms@example.com', site_url: 'https://qms.example.com' });

check((await tech('/committees')).s === 403, 'someone without a committees role cannot open it');
const depts = (await owner('/departments')).j.departments.filter((d) => !d.is_team);
const [deptA, deptB] = depts;
check((await owner('/users', 'POST', { name: 'أمين لجنة', name_en: 'Secretary', email: 'sec@example.com', role: 'user', password: 'secret-pass-3', meetings_role: 'secretary', department_id: deptA.id })).s === 200, 'owner adds a committee secretary');
check((await owner('/users', 'POST', { name: 'مطلع اللجان', name_en: 'Viewer', email: 'mv@example.com', role: 'user', password: 'secret-pass-3', meetings_role: 'viewer' })).s === 200, 'owner adds a committees viewer');
const sec = await login('sec@example.com', 'secret-pass-3');
const mv = await login('mv@example.com', 'secret-pass-3');
r = await sec('/bootstrap');
check(r.j.user.meetings === 'secretary' && r.j.user.meetings_role === 'secretary', 'the secretary gets the committees role', r.j.user);

// A monthly committee: the schedule is made for a year, on the same weekday of the month.
const today = (await owner('/committees')).j.today;
const first = plus(today, 10);
const base = { name_ar: 'لجنة الجودة وسلامة المرضى', name_en: 'Quality & Patient Safety Committee', frequency: 'monthly', first_date: first, start_time: '10:00', duration_min: 60, venue: 'قاعة الاجتماعات', quorum_pct: 50 };
check((await sec('/committees', 'POST', base)).s === 403, 'a secretary cannot add a hospital committee');
check((await owner('/committees', 'POST', { ...base, name_ar: 'Latin' })).s === 400, 'the Arabic name must be Arabic');
check((await owner('/committees', 'POST', { ...base, first_date: '' })).j.error === 'mtg_first_date', 'a repeating committee needs its first date');
r = await owner('/committees', 'POST', base);
check(r.s === 200 && r.j.code === 'COM-001', 'owner adds a committee, coded COM-001', r.j);
const qid = r.j.id;
r = await owner('/committees/' + qid);
const sess = r.j.sessions;
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const nth = (d) => Math.ceil(Number(d.slice(8)) / 7);
check(sess.length >= 12 && sess.length <= 13 && sess[0].date === first && sess[0].code === 'COM-001-S001', 'a year of monthly sessions starting on the first date', sess.map((s) => s.date));
check(sess.every((s) => dow(s.date) === dow(first) && (nth(s.date) === nth(first) || (nth(first) === 5 && nth(s.date) === 4))), 'every session keeps the weekday and its place in the month', sess.map((s) => s.date));

// Members: by employee number (Arabic digits too), with roles; switching off needs a reason.
const staff = (await owner('/staff')).j.staff;
const emp = staff[0];
const arabicNo = String(emp.emp_no).replace(/\d/g, (x) => String.fromCharCode(0x660 + Number(x)));
r = await owner('/committees/staff?q=' + encodeURIComponent(arabicNo));
check(r.s === 200 && r.j.staff[0] && r.j.staff[0].emp_no === emp.emp_no, 'a staff member is found by an employee number in Arabic digits', r.j);
check((await owner('/committees/' + qid + '/members', 'POST', { emp_no: emp.emp_no, name: emp.name, email: 'chair@example.com', role: 'chair', position: 'Medical Director' })).s === 200, 'the chair is added by employee number');
check((await owner('/committees/' + qid + '/members', 'POST', { emp_no: emp.emp_no, name: emp.name })).j.error === 'mtg_member_taken', 'the same person cannot be added twice');
check((await owner('/committees/' + qid + '/members', 'POST', { name: 'أمين لجنة', email: 'sec@example.com', role: 'secretary' })).s === 200, 'the secretary is added');
r = await owner('/committees/' + qid + '/members', 'POST', { name: 'عضو', name_en: 'Member', email: 'member@example.com', role: 'member', substitute_name: 'بديل', substitute_email: 'sub@example.com' });
const memberId = r.j.id;
check((await owner('/committees/' + qid + '/members', 'POST', { name: 'عضو', email: 'not-an-email' })).j.error === 'invalid_email', 'a bad email is refused');
check((await owner('/committees/' + qid + '/members/' + memberId, 'PUT', { active: false })).j.error === 'mtg_reason_required', 'switching a member off needs a reason');
check((await owner('/committees/' + qid + '/members/' + memberId, 'PUT', { active: false, inactive_reason: 'إجازة طويلة' })).s === 200, 'a member is switched off with a reason');
r = await owner('/committees/' + qid);
const stored = r.j.members.find((m) => m.emp_no === emp.emp_no);
check(stored && stored.role === 'chair' && r.j.members[0].role === 'chair' && r.j.members.find((m) => m.id === memberId).inactive_reason === 'إجازة طويلة', 'members are listed chair first and the reason is kept', r.j.members);
check(r.j.committee.quorum_n === 1, 'the quorum counts the active members', r.j.committee);
await owner('/committees/' + qid + '/members/' + memberId, 'PUT', { active: true });

// The secretary of this committee runs it; a viewer only reads.
r = await sec('/committees');
check(r.j.committees.find((c) => c.id === qid).can_run === true && r.j.can_create === false, 'the secretary runs the committee they keep the minutes of', r.j.committees);
check((await mv('/committees/' + qid)).j.can_run === false, 'a viewer reads, without running');
check((await mv('/committees/' + qid + '/members', 'POST', { name: 'x' })).s === 403, 'a viewer cannot add members');

// Papers.
const fd = new FormData();
fd.set('kind', 'tor');
fd.set('file', new Blob(['%PDF-1.4 terms'], { type: 'application/pdf' }), 'ToR.pdf');
r = await sec.form('/committees/' + qid + '/files', 'POST', fd);
check(r.s === 200 && r.j.id, 'the secretary uploads the terms of reference', r);
const fileId = r.j.id;
const bad = new FormData();
bad.set('file', new Blob(['x'], { type: 'application/x-msdownload' }), 'run.exe');
check((await owner.form('/committees/' + qid + '/files', 'POST', bad)).j.error === 'mtg_file_type', 'other file types are refused');
const got = await mv.raw('/committees/' + qid + '/files/' + fileId);
check(got.status === 200 && got.headers.get('content-type') === 'application/pdf', 'a viewer opens the paper', got.status);

// The daily job: the first session is 10 days away, so nothing yet; move it within the week and invite.
await sent();
await cron('0 5 * * *');
await new Promise((res) => setTimeout(res, 800));
check((await sent()).length === 0, 'no invitation more than a week ahead');
const s1 = sess[0];
check((await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'reschedule', date: plus(today, 2) })).j.error === 'mtg_reason_required', 'moving a session needs a reason');
r = await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'reschedule', date: plus(today, 2), start_time: '11:30', reason: 'تعارض مع زيارة الاعتماد' });
check(r.s === 200 && r.j.notified === true, 'the secretary moves the session inside the week and the members are told', r.j);
let mails = await sent();
const brevo = mails[0] && mails[0].body;
const to = brevo ? brevo.messageVersions[0].to.map((x) => x.email) : [];
check(brevo && to.includes('chair@example.com') && to.includes('sub@example.com') && /تغيير موعد اجتماع/.test(brevo.subject), 'the change goes to members and substitutes', brevo && { subject: brevo.subject, to });
const ics = brevo && brevo.attachment && Buffer.from(brevo.attachment[0].content, 'base64').toString('utf8');
check(ics && ics.includes('BEGIN:VEVENT') && ics.includes('SEQUENCE:1') && ics.includes('T083000Z'), 'with a calendar file at the new time (11:30 Riyadh = 08:30 UTC)', ics);
r = await owner('/committees/' + qid);
const moved = r.j.sessions.find((s) => s.id === s1.id);
check(moved.status === 'rescheduled' && moved.original_date === first && moved.invited_at && moved.remind3_at, 'the session shows the move and the old date; a late invitation counts as the 3-day reminder', moved);

// Reminders: the 1-day one goes on the day before.
await cron('0 5 * * *');
await new Promise((res) => setTimeout(res, 800));
check((await sent()).length === 0, 'nothing more two days before');
// Postpone without a date: told, no calendar date.
r = await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'postpone', reason: 'غياب الرئيس' });
check(r.s === 200 && r.j.notified === true, 'a postponement without a new date is announced', r.j);
mails = await sent();
check(mails[0] && /تأجيل اجتماع/.test(mails[0].body.subject) && !mails[0].body.attachment, 'the postponement email has no calendar file', mails[0] && mails[0].body.subject);
check((await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'postpone', date: plus(today, -1), reason: 'x' })).j.error === 'mtg_past_date', 'a past date is refused');
r = await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'reschedule', date: plus(today, 1), reason: 'موعد جديد' });
check(r.j.notified === true, 'the new date is announced');
await sent();
// Cancel: a CANCEL calendar file.
r = await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'cancel', reason: 'دمج مع الجلسة التالية' });
mails = await sent();
const cics = mails[0] && Buffer.from(mails[0].body.attachment[0].content, 'base64').toString('utf8');
check(r.j.notified === true && cics && cics.includes('METHOD:CANCEL') && cics.includes('STATUS:CANCELLED'), 'a cancellation sends a cancelling calendar file', cics);
check((await sec('/committee-sessions/' + s1.id, 'PUT', { action: 'reschedule', date: plus(today, 3), reason: 'x' })).j.error === 'mtg_session_closed', 'a cancelled session cannot be moved');

// An extraordinary session tomorrow: invited at once; the daily job then sends the 1-day reminder only once.
r = await sec('/committees/' + qid + '/sessions', 'POST', { date: plus(today, 1), start_time: '09:00', reason: 'حادثة جسيمة' });
check(r.s === 200 && r.j.notified === true, 'an extraordinary session within the week is invited at once', r.j);
await sent();
await cron('0 5 * * *');
await new Promise((res) => setTimeout(res, 800));
check((await sent()).length === 0, 'its reminders already count as sent');
r = await owner('/committees/' + qid);
check(r.j.sessions.some((s) => s.kind === 'extraordinary') && r.j.sessions.map((s) => s.num).join() === r.j.sessions.map((_, i) => i + 1).join(), 'sessions stay numbered in date order', r.j.sessions.map((s) => [s.num, s.date]));
const icsRes = await mv.raw('/committee-sessions/' + r.j.sessions[1].id + '/ics');
check(icsRes.status === 200 && (icsRes.headers.get('content-type') || '').startsWith('text/calendar'), 'any session can be added to a calendar', icsRes.status);

// A changed frequency remakes the untouched future sessions; the ones already sent stay.
r = await owner('/committees/' + qid, 'PUT', { ...base, frequency: 'quarterly' });
check(r.s === 200, 'the frequency is changed', r.j);
r = await owner('/committees/' + qid);
const regular = r.j.sessions.filter((s) => s.kind === 'regular' && s.status === 'scheduled');
check(regular.length >= 3 && regular.length <= 5, 'the year now has quarterly sessions', regular.map((s) => s.date));
check(r.j.sessions.some((s) => s.id === s1.id && s.status === 'cancelled'), 'the session already handled is kept');

// Departmental meetings: a secretary adds one for their own department only; staff are suggested.
const dep = { kind: 'department', name_ar: 'اجتماع قسم الجودة', name_en: 'Quality department meeting', frequency: 'weekly', first_date: plus(today, 3), start_time: '13:00', duration_min: 30, quorum_pct: 50 };
check((await sec('/committees', 'POST', { ...dep, department_id: deptB.id })).s === 403, 'a secretary cannot add another department’s meeting');
r = await sec('/committees', 'POST', { ...dep, department_id: deptA.id });
check(r.s === 200 && r.j.code === 'DEP-001', 'a secretary adds their department’s weekly meeting', r.j);
const did = r.j.id;
r = await sec('/committees/' + did);
check(r.j.can_run && r.j.sessions.length >= 50 && r.j.sessions.every((s) => dow(s.date) === dow(dep.first_date)), 'a year of weekly sessions on the same weekday', r.j.sessions.length);
r = await sec('/committees/staff?department_id=' + deptA.id);
check(r.s === 200 && Array.isArray(r.j.staff), 'the department’s staff are offered as members', r.j);

// A special urgent meeting: one session, invited as soon as a member is there and the invitation is sent.
r = await owner('/committees', 'POST', { kind: 'special', name_ar: 'اجتماع تحليل سبب جذري', name_en: 'RCA meeting', meeting_type: 'rca', first_date: plus(today, 1), start_time: '12:00', duration_min: 90, quorum_pct: 50 });
check(r.s === 200 && r.j.code === 'SPM-001', 'a special meeting is added', r.j);
const sp = r.j.id;
await owner('/committees/' + sp + '/members', 'POST', { name: 'محلل', email: 'rca@example.com', role: 'chair' });
r = await owner('/committees/' + sp);
check(r.j.sessions.length === 1 && r.j.committee.frequency === 'none', 'a special meeting has its one session', r.j.sessions);
r = await owner('/committees/' + sp + '/sessions/' + r.j.sessions[0].id + '/invite', 'POST');
mails = await sent();
check(r.j.notified === true && mails.length === 1 && /دعوة لاجتماع/.test(mails[0].body.subject), 'its invitation is sent on demand', mails.map((m) => m.body.subject));

// Calendar, list and the log.
r = await mv('/committees/calendar?from=' + today + '&to=' + plus(today, 40));
check(r.s === 200 && r.j.sessions.some((s) => s.committee_id === did) && r.j.sessions.some((s) => s.committee_id === sp), 'the calendar shows every committee’s sessions', r.j.sessions.length);
r = await owner('/committees');
const q = r.j.committees.find((c) => c.id === qid);
check(q.members === 3 && q.chair === emp.name && q.next_at, 'the list shows members, chair and next session', q);
r = await owner('/logs');
check(r.j.logs.some((l) => l.entity === 'committee_session' && l.action === 'reschedule'), 'session changes are in the activity log');

// The home page shows the meetings coming up: everyone with a role, and members without one.
r = await owner('/home');
check(r.s === 200 && r.j.meetings && r.j.meetings.next.length > 0 && r.j.meetings.upcoming > 0, 'home shows the upcoming meetings', r.j.meetings);
check(r.j.meetings.next.every((m, i, a) => !i || a[i - 1].date <= m.date), 'upcoming meetings are in date order');
r = await tech('/home');
check(r.s === 200 && !r.j.meetings, 'someone outside every committee sees no meetings on the home page', r.j.meetings);

// Deleting: a committee with invitations sent is switched off instead.
r = await owner('/committees/' + qid, 'DELETE');
check(r.s === 200 && r.j.retired === true, 'a committee with history is switched off, not deleted', r.j);
check((await sec('/committees/' + did, 'DELETE')).s === 403, 'only a manager deletes');

// Minutes and attendance: the secretary writes, the chair (or a manager) approves, open actions carry over.
{
  r = await owner('/committees/' + qid + '/sessions', 'POST', { date: today, start_time: '08:00', reason: 'محضر' });
  check(r.s === 200, 'a session today is added', r.j);
  const cm = (await owner('/committees/' + qid)).j;
  const ses = cm.sessions.find((x) => x.date === today && x.start_time === '08:00');
  const active = cm.members.filter((m) => m.active);
  let m = await sec('/committee-sessions/' + ses.id + '/minutes');
  check(m.s === 200 && m.j.can_edit && m.j.members.length === active.length && m.j.session.minutes_status === 'draft', 'the secretary opens the minutes', m.j);
  check((await mv('/committee-sessions/' + ses.id + '/minutes', 'PUT', { items: [] })).s === 403, 'a viewer cannot write the minutes');
  const items = [{ subject: 'افتتاح الاجتماع' }, { subject: 'مؤشرات الربع', discussion: 'نقاش', action: 'رفع نسبة الإبلاغ', responsibility: 'مدير الجودة', target_date: plus(today, 30), status: 'open' }];
  const att = active.map((x, i) => ({ member_id: x.id, status: i === 0 ? 'absent' : 'present' }));
  check((await sec('/committee-sessions/' + ses.id + '/minutes', 'PUT', { submit: true, items, attendance: att.slice(1) })).j?.error === 'mtg_attendance_missing', 'every member is marked before sending');
  r = await sec('/committee-sessions/' + ses.id + '/minutes', 'PUT', { submit: true, items, attendance: att, time_started: '08:10' });
  check(r.s === 200 && r.j.minutes_status === 'pending', 'the minutes go to the chair', r.j);
  check((await sec('/committee-sessions/' + ses.id + '/minutes/approve', 'POST')).s === 403, 'the secretary does not approve their own minutes');
  check((await owner('/committee-sessions/' + ses.id + '/minutes/approve', 'POST')).s === 200, 'a manager approves');
  check((await sec('/committee-sessions/' + ses.id + '/minutes', 'PUT', { items })).j?.error === 'mtg_minutes_locked', 'approved minutes are locked');
  const after = (await owner('/committees/' + qid)).j;
  check(after.sessions.find((x) => x.id === ses.id).status === 'held', 'writing the minutes marks the session held');
  const absent = after.members.find((x) => x.id === active[0].id).attendance;
  const came = after.members.find((x) => x.id === active[1].id).attendance;
  check(absent && absent.pct === 0 && absent.absent === 1 && came && came.pct === 100, 'each member has an attendance rate', { absent, came });
  r = await owner('/committees/' + qid + '/sessions', 'POST', { date: today, start_time: '23:00', reason: 'متابعة' });
  const ses2 = (await owner('/committees/' + qid)).j.sessions.find((x) => x.date === today && x.start_time === '23:00');
  m = await sec('/committee-sessions/' + ses2.id + '/minutes');
  check(m.j.carry.length === 1 && m.j.carry[0].action === 'رفع نسبة الإبلاغ', 'an open action carries to the next minutes', m.j.carry);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

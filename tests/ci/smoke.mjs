// End-to-end checks against a local server (tests/ci/run.sh starts it).
// Each check prints PASS or FAIL; any FAIL makes the run fail.
import { inflateRawSync } from 'node:zlib';

const B = process.env.BASE || 'http://localhost:8787';
let failed = 0;
const check = (cond, label, extra) => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300)));
};
const session = () => {
  let cookie = '';
  const call = async (path, method = 'GET', body) => {
    const r = await fetch(B + '/api' + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('fm_session=')) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  return call;
};
const login = async (email, password) => {
  const api = session();
  const r = await api('/login', 'POST', { email, password });
  check(r.s === 200, 'sign in ' + email, r);
  return api;
};

// setup and the starter data
const owner = session();
let r = await owner('/setup', 'POST', { name: 'المالك', name_en: 'Owner', email: 'owner@example.com', password: 'secret-pass-1' });
check(r.s === 200, 'setup makes the owner', r);
r = await owner('/bootstrap');
check(r.s === 200 && r.j.user && r.j.user.is_owner, 'owner is signed in', r.j && r.j.user);
r = await owner('/departments');
check(r.s === 200 && r.j.departments.length > 10, 'starter departments seeded', r.j && r.j.departments.length);
const team = r.j.departments.find((d) => d.is_team);

// accounts at each level
const add = async (body) => (await owner('/users', 'POST', { password: 'secret-pass-2', department_id: null, ...body })).s;
check((await add({ name: 'مدير عام', name_en: 'Super Two', email: 'super@example.com', role: 'super_admin' })) === 200, 'owner adds a super admin');
check((await add({ name: 'مدير الأنظمة', name_en: 'Systems', email: 'systems@example.com', role: 'systems_admin' })) === 200, 'owner adds a systems admin');
check((await add({ name: 'فني', name_en: 'Tech', email: 'tech@example.com', role: 'user', desk_role: 'technician', department_id: team.id, job_title: 'engineer' })) === 200, 'owner adds a technician');
check((await add({ name: 'Latin', name_en: 'Latin', email: 'latin@example.com', role: 'user' })) === 400, 'latin letters refused in an Arabic name');

const sup = await login('super@example.com', 'secret-pass-2');
check((await sup('/users', 'POST', { name: 'مدير ثالث', name_en: 'Super Three', email: 'super3@example.com', role: 'super_admin', password: 'secret-pass-9' })).j?.error === 'super_admin_owner_only', 'only the owner appoints a super admin');
const sys = await login('systems@example.com', 'secret-pass-2');
const tech = await login('tech@example.com', 'secret-pass-2');

// systems admin: every system, but not the accounts
check((await sys('/users')).s === 200, 'systems admin sees the users');
check((await sys('/users', 'POST', { name: 'س', name_en: 'S', email: 's@example.com', role: 'super_admin', password: 'secret-pass-9' })).s === 403, 'systems admin cannot add a user');
check((await sys('/users/4', 'DELETE')).s === 403, 'systems admin cannot delete a user');
check((await sys('/users/4/2fa-reset', 'POST')).s === 403, 'systems admin cannot reset two-step sign-in');
check((await sys('/departments', 'POST', { name_ar: 'قسم تجربة', name_en: 'Test Dept' })).s === 200, 'systems admin manages departments');
check((await sys('/logs')).s === 200, 'systems admin reads the activity log');

// owner-only settings
check((await sup('/settings', 'PUT', { org_name_ar: 'مستشفى' })).s === 403, 'other super admin cannot change the brand');
check((await sup('/settings', 'PUT', { require_2fa: 'super' })).s === 403, 'other super admin cannot change two-step sign-in');
check((await sup('/settings', 'PUT', { backup_email: true })).s === 403, 'other super admin cannot change the backup email');
r = await sup('/settings');
check(r.s === 200 && !('mail_provider' in r.j.settings), 'other super admin does not see the mail settings', r.j && Object.keys(r.j.settings));
check(r.s === 200 && !('org_name_ar' in r.j.settings) && !('require_2fa' in r.j.settings) && !('ai_enabled' in r.j.settings) && !r.j.license, 'other super admin sees none of the owner settings page', r.j && Object.keys(r.j.settings));
check(r.s === 200 && 'sla_p1_resp' in r.j.settings && 'near_days' in r.j.settings, 'other super admin still gets the systems settings');
check((await sup('/settings/test-email', 'POST')).s === 403, 'other super admin cannot send the test email');
check((await sup('/settings', 'PUT', { require_qr: false })).s === 200, 'other super admin changes ticket settings');
check((await tech('/settings')).s === 403, 'technician has no settings');
r = await sup('/backup');
check(r.s === 200 && r.j.kind === 'pdf', 'a super admin takes the PDFs only, not the database', r.j && r.j.kind);
r = await sys('/backup');
check(r.s === 200 && r.j.kind === 'pdf', 'a systems admin takes the PDFs only', r.j && r.j.kind);
check((await tech('/users')).s === 403, 'technician has no user list');

// the systems open for the right people
for (const p of ['/tickets', '/assets', '/files']) check((await sys(p)).s === 200, 'systems admin opens ' + p);
check((await tech('/tickets')).s === 200, 'technician opens tickets');

// mail set up through Brevo (a stand-in here), and the weekly backup sent to the owner
r = await owner('/settings', 'PUT', { mail_provider: 'brevo', brevo_key: 'xkeysib-' + 'a'.repeat(64) + '-test', mail_from: 'notifications@example.com', sender_name: 'Portal', backup_email: true });
check(r.s === 200 && r.j.settings.backup_email === true, 'owner turns on the weekly backup email', r);
await owner('/__sent');
const fire = async (ms) => {
  await fetch(B + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('*/15 * * * *') + '&time=' + ms);
  await new Promise((res) => setTimeout(res, 3000));
};
await fire(Date.UTC(2026, 9, 30, 2, 5)); // a Friday, 02:05 UTC
r = await owner('/backup/auto');
check(r.s === 200 && r.j.backups.length === 1, 'Friday run keeps a copy in storage', r.j);
const mails = (await owner('/__sent')).j;
const m = mails.find((x) => x.via === 'brevo' && x.body.attachment);
check(!!m, 'the copy is emailed with an attachment', mails.map((x) => x.body.subject));
if (m) {
  const to = m.body.messageVersions[0].to[0].email;
  check(to === 'owner@example.com', 'sent to the owner only', to);
  check(/النسخة الاحتياطية/.test(m.body.subject) && /Weekly backup/.test(m.body.subject), 'subject is Arabic and English', m.body.subject);
  const zip = Buffer.from(m.body.attachment[0].content, 'base64');
  const nameLen = zip.readUInt16LE(26);
  const size = zip.readUInt32LE(18);
  const data = JSON.parse(inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)).toString());
  check(m.body.attachment[0].name.endsWith('.zip') && data.kind === 'full' && data.data.users.length === 4, 'attachment is a ZIP of the full data', m.body.attachment[0].name);
  check(!('password_hash' in data.data.users[0]) && !('brevo_key' in data.data.settings), 'no passwords or keys in the copy');
}
r = await owner('/backup/auto/email', 'POST');
check(r.s === 200 && r.j.to === 'owner@example.com', 'owner can send the latest copy now', r);
check((await sup('/backup/auto/email', 'POST')).s === 403, 'other super admin cannot send the copy');

// integration keys: the owner only
check((await owner('/api-keys')).s === 200, 'owner manages the integration keys');
check((await sup('/api-keys')).s === 403, 'other super admin has no integration keys');
check((await sys('/api-keys', 'POST', { name_ar: 'ربط', name_en: 'Link', scopes: ['tickets_read'] })).s === 403, 'systems admin cannot make an integration key');

// the monthly report by email
check((await tech('/reports/mail')).s === 403, 'technician has no monthly report email');
check((await sys('/reports/mail', 'PUT', { on: true, to: 'not-an-email' })).s === 400, 'a wrong address is refused');
r = await sys('/reports/mail', 'PUT', { on: true, to: 'boss@example.com, Quality@Example.com' });
check(r.s === 200 && r.j.to === 'boss@example.com,quality@example.com', 'systems admin sets the monthly report addresses', r);
await owner('/__sent');
r = await sys('/reports/mail', 'POST');
check(r.s === 200 && r.j.sent === 2, "last month's report sent now", r);
{
  const sent = (await owner('/__sent')).j.filter((x) => x.via === 'brevo');
  const v = sent.length ? sent[0].body.messageVersions : [];
  check(v.length === 2 && v.every((x) => x.to.length === 1), 'each address gets its own copy', v.map((x) => x.to));
  check(v.length && /تقرير شهر/.test(v[0].subject) && /Report for/.test(v[0].subject) && /البلاغات/.test(v[0].htmlContent) && /Requests/.test(v[0].htmlContent), 'the report is in Arabic and English', v[0] && v[0].subject);
}
r = await owner('/reports/mail');
check(r.s === 200 && r.j.on === true && r.j.defaults.length >= 2, 'the setting reads back', r.j);

// the owner's health page
r = await owner('/health');
check(r.s === 200 && r.j.users.active === 4 && r.j.users.seen_7 >= 3 && r.j.logins.length >= 1, 'owner sees the health page', r.j && r.j.users);
check(r.s === 200 && r.j.backup && r.j.errors_7 === 0 && Array.isArray(r.j.errors), 'health page shows the backup and no failures', r.j && { backup: r.j.backup, errors: r.j.errors });
check((await sup('/health')).s === 403, 'other super admin has no health page');
check((await sys('/health')).s === 403, 'systems admin has no health page');
check((await tech('/health')).s === 403, 'technician has no health page');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

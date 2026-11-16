// Restore drill: takes the owner's full backup from the running test site, rebuilds it with
// tools/restore-sql.mjs in a second, empty copy of the site (port 8788), and checks that every
// table comes back the same. Runs after smoke.mjs and systems.mjs, on their data.
// With ON_NODE=1 both copies are the Node.js server (server/node.mjs) and the SQL goes straight into its SQLite file.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ON_NODE = process.env.ON_NODE === '1';

const A = 'http://localhost:8787';
const B = 'http://localhost:8788';
const PASSWORD = 'restored-pass-1';
let failed = 0;
const check = (cond, label, extra) => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300)));
};
const login = async (base, email, password) => {
  let cookie = '';
  const api = async (path, method = 'GET', body, raw) => {
    const r = await fetch(base + '/api' + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('fm_session=')) cookie = sc.split(';')[0];
    if (raw) return { s: r.status, raw: Buffer.from(await r.arrayBuffer()) };
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const r = await api('/login', 'POST', { email, password });
  return r.s === 200 ? api : null;
};

const owner = await login(A, 'owner@example.com', 'secret-pass-1');

// The copy in Google Drive (the Apps Script is a stand-in here, see entry.js): the data now, then the files.
await owner('/settings', 'PUT', { mail_url: 'https://script.google.com/macros/s/TEST/exec', mail_token: 'wrong-token' });
let d = await owner('/backup/auto/drive', 'POST', { on: true });
check(d.s === 502 && d.j.error === 'drive_unauthorized', 'a wrong Apps Script token is refused and the copy stays off', d);
check((await owner('/backup/auto')).j.drive.on === false, 'the Drive copy is still off');
await owner('/settings', 'PUT', { mail_token: 'tok-123' });
d = await owner('/backup/auto/drive', 'POST', { on: true });
check(d.s === 200 && d.j.drive.on && d.j.drive.data_at && d.j.drive.files_total > 0, 'turning it on sends a data copy at once', d.j);
const driveList = async () => (await fetch(A + '/api/__drive')).json();
let inDrive = await driveList();
const dataZip = inDrive.find((f) => /\/data\/\d{4}-\d{2}-\d{2}\.zip$/.test(f.path));
check(!!dataZip, 'the data copy is a ZIP in the data folder', inDrive.map((f) => f.path));
if (dataZip) {
  // One entry, deflate: the JSON inside is the full backup.
  const zip = Buffer.from(await (await fetch(A + '/api/__drive?path=' + encodeURIComponent(dataZip.path))).arrayBuffer());
  const nameLen = zip.readUInt16LE(26);
  const packed = zip.subarray(30 + nameLen + zip.readUInt16LE(28), 30 + nameLen + zip.readUInt16LE(28) + zip.readUInt32LE(18));
  const inside = JSON.parse(inflateRawSync(packed).toString('utf8'));
  check(inside.kind === 'full' && inside.data.tickets.length > 0, 'the ZIP in Drive holds the full data', inside.kind);
}
// The files go in the next 15-minute runs (not the daily 05:00 or the Friday backup run).
for (let i = 0; i < 10; i++) {
  await fetch(A + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('*/15 * * * *') + '&time=' + Date.UTC(2026, 10, 16, 10, 15 * (i % 4)));
  await new Promise((r) => setTimeout(r, ON_NODE ? 300 : 2500));
  d = (await owner('/backup/auto')).j.drive;
  if (d.files_sent === d.files_total) break;
}
check(d.files_total > 0 && d.files_sent === d.files_total && !d.error, 'every uploaded file reaches Drive', d);
inDrive = await driveList();
const driveFiles = inDrive.filter((f) => f.path.includes('/files/'));
check(driveFiles.length === d.files_total, 'one Drive file per stored file', { drive: driveFiles.length, total: d.files_total });
// Nothing new: the next run sends nothing again.
const countBefore = inDrive.length;
await fetch(A + '/cdn-cgi/handler/scheduled?cron=' + encodeURIComponent('*/15 * * * *') + '&time=' + Date.UTC(2026, 10, 16, 11, 0));
await new Promise((r) => setTimeout(r, ON_NODE ? 300 : 2500));
check((await driveList()).length === countBefore, 'files already in Drive are not sent again');
// The Drive files folder as it would be downloaded and unzipped: one file per storage key.
rmSync('.drive-files', { recursive: true, force: true });
for (const f of driveFiles) {
  const key = f.path.slice(f.path.indexOf('/files/') + 7);
  mkdirSync(dirname('.drive-files/' + key), { recursive: true });
  writeFileSync('.drive-files/' + key, Buffer.from(await (await fetch(A + '/api/__drive?path=' + encodeURIComponent(f.path))).arrayBuffer()));
}

const before = (await owner('/backup')).j;
check(before && before.kind === 'full' && before.data.tickets.length > 0, 'the owner downloads a full backup with data', before && before.kind);
writeFileSync('restore-backup.json', JSON.stringify(before));

const sql = spawnSync('node', ['../../tools/restore-sql.mjs', 'restore-backup.json'], { env: { ...process.env, OWNER_PASSWORD: PASSWORD }, encoding: 'utf8', maxBuffer: 64 << 20 });
check(sql.status === 0 && sql.stdout.includes('INSERT INTO tickets'), 'the backup turns into restore SQL', sql.stderr);
writeFileSync('restore.sql', sql.stdout);

// A second, empty site: its first request builds the tables (and the starter data the restore replaces).
rmSync('.state2', { recursive: true, force: true });
// The uploaded files back from the Drive copy into the empty copy's storage (before it starts, as on a new site).
const files = spawnSync('node', ['../../tools/restore-files.mjs', '.drive-files', ...(ON_NODE ? ['--dir', '.state2/files'] : ['--bucket', 'qms-files-ci', '--local', '--persist-to', '.state2', '-c', 'wrangler.jsonc'])], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
check(files.status === 0 && files.stdout.includes(`restored ${driveFiles.length} of ${driveFiles.length}`), 'the files go back from the Drive copy', (files.stderr || files.stdout).slice(-300));
const site = ON_NODE
  ? spawn('node', ['../../server/node.mjs'], { detached: true, stdio: 'ignore', env: { ...process.env, WORKER: 'tests/ci/entry.js', DATA_DIR: '.state2', PORT: '8788', S3_BUCKET: '' } })
  : spawn('npx', ['wrangler', 'dev', '-c', 'wrangler.jsonc', '--persist-to', '.state2', '--port', '8788'], { detached: true, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
const stop = () => {
  try {
    process.kill(-site.pid, 'SIGTERM');
  } catch {}
};
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = await fetch(B + '/api/bootstrap').then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  check(up, 'the empty copy starts');
  check((await fetch(B + '/api/bootstrap').then((r) => r.json())).needsSetup === true, 'the copy is empty before the restore');

  const run = ON_NODE
    ? spawnSync('node', ['--no-warnings', '../../server/apply-sql.mjs', 'restore.sql'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: '.state2' } })
    : spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.state2', '-c', 'wrangler.jsonc', '--file', 'restore.sql'], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  check(run.status === 0, 'the restore SQL runs', (run.stderr || run.stdout).slice(-300));

  const back = await login(B, 'owner@example.com', PASSWORD);
  check(!!back, 'the owner signs in to the copy with the new password');
  check(!(await login(B, 'owner@example.com', 'secret-pass-1')), 'the old owner password does not work in the copy');
  check(!(await login(B, 'tech@example.com', 'secret-pass-2')), 'other accounts must reset their password');
  const after = back && (await back('/backup')).j;
  if (after) {
    for (const [table, rows] of Object.entries(before.data)) {
      // The copy's log has the restore's own sign-in and backup on top of the old entries.
      const got = table === 'logs' ? after.data.logs.slice(0, rows.length) : after.data[table];
      check(JSON.stringify(got) === JSON.stringify(rows), `table ${table} comes back the same (${Array.isArray(rows) ? rows.length : Object.keys(rows).length})`, { want: Array.isArray(rows) ? rows.length : 0, got: Array.isArray(got) ? got.length : 0 });
    }
    const tk = before.data.tickets[0];
    check((await back('/tickets/' + tk.id)).s === 200, 'a restored request opens in the copy');
    // Each uploaded file opens in the copy with the same bytes as on the original site.
    const paths = [
      ...before.data.ovr.filter((o) => o.photo_key).map((o) => `/ovr/${o.id}/photo`),
      ...before.data.inv_files.map((f) => `/inv/${f.inv_id}/files/${f.id}`),
      ...before.data.committee_files.map((f) => `/committees/${f.committee_id}/files/${f.id}`),
    ];
    let same = 0;
    let differ = [];
    for (const p of paths) {
      const a = await owner(p, 'GET', undefined, true);
      if (a.s !== 200) continue;
      const b = await back(p, 'GET', undefined, true);
      if (b.s === 200 && Buffer.compare(a.raw, b.raw) === 0) same++;
      else differ.push(p + ' ' + b.s);
    }
    check(same > 0 && differ.length === 0, `uploaded files open the same in the copy (${same})`, differ);
  }
} finally {
  stop();
  rmSync('restore-backup.json', { force: true });
  rmSync('restore.sql', { force: true });
  rmSync('.drive-files', { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

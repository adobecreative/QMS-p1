// Restore drill: takes the owner's full backup from the running test site, rebuilds it with
// tools/restore-sql.mjs in a second, empty copy of the site (port 8788), and checks that every
// table comes back the same. Runs after smoke.mjs and systems.mjs, on their data.
// With ON_NODE=1 both copies are the Node.js server (server/node.mjs) and the SQL goes straight into its SQLite file.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeZip } from '../../src/lib/backuplink.js';

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

// The full backup by link: saving the backup address mails a link at once.
let r = await owner('/backup/auto/link', 'POST', { to: 'not-an-email' });
check(r.s === 400, 'a wrong backup address is refused', r);
r = await owner('/backup/auto/link', 'POST', { to: 'nas@example.com' });
check(r.s === 200 && r.j.link && r.j.link.uses === 0 && r.j.link.max_uses === 3, 'saving the backup address sends a link', r.j);
const mails = JSON.stringify((await owner('/__sent')).j);
const found = mails.match(/\/api\/backup\/link\/[0-9a-f]{48}/);
check(!!found && mails.includes('nas@example.com'), 'the link goes to the backup address', mails.slice(0, 300));
const linkUrl = A + (found ? found[0] : '/api/backup/link/x');
check((await fetch(A + '/api/backup/link/' + 'a'.repeat(48))).status === 404, 'a made-up link does not work');
const dl = await fetch(linkUrl);
check(dl.status === 200 && dl.headers.get('content-type') === 'application/zip', 'the link downloads a ZIP', dl.status);
writeFileSync('link-backup.zip', Buffer.from(await dl.arrayBuffer()));
rmSync('.linkzip', { recursive: true, force: true });
const unz = spawnSync('unzip', ['-q', 'link-backup.zip', '-d', '.linkzip'], { encoding: 'utf8' });
check(unz.status === 0, 'the ZIP opens', unz.stderr);
const inZip = existsSync('.linkzip/backup.json') && JSON.parse(readFileSync('.linkzip/backup.json', 'utf8'));
check(inZip && inZip.kind === 'full' && inZip.data.tickets.length > 0, 'the ZIP holds the full data', inZip && inZip.kind);
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name])) : []);
const zipFiles = walk('.linkzip/files');
check(zipFiles.length > 0, `the ZIP holds the uploaded files (${zipFiles.length})`);
check((await fetch(linkUrl)).status === 200 && (await fetch(linkUrl)).status === 200, 'the link works 3 times');
check((await fetch(linkUrl)).status === 410, 'a 4th download is refused');
r = await owner('/backup/auto');
check(r.j.link && r.j.link.uses === 3, 'the owner sees the downloads', r.j.link);
// The same writer past the 4 GB marks (ZIP64 records forced on a small archive) still gives a valid ZIP.
{
  const { readable, writable } = new TransformStream();
  const job = writeZip(writable, [{ name: 'a.txt', open: async () => new TextEncoder().encode('hello') }, { name: 'dir/b.bin', open: async () => new Blob([new Uint8Array(70000).fill(7)]).stream() }], { force64: true });
  writeFileSync('zip64.zip', Buffer.from(await new Response(readable).arrayBuffer()));
  await job;
  const t64 = spawnSync('unzip', ['-t', 'zip64.zip'], { encoding: 'utf8' });
  check(t64.status === 0 && /No errors/.test(t64.stdout), 'a ZIP64 archive tests clean', t64.stdout + t64.stderr);
  rmSync('zip64.zip', { force: true });
}

const before = (await owner('/backup')).j;
check(before && before.kind === 'full' && before.data.tickets.length > 0, 'the owner downloads a full backup with data', before && before.kind);
writeFileSync('restore-backup.json', JSON.stringify(before));

const sql = spawnSync('node', ['../../tools/restore-sql.mjs', 'restore-backup.json'], { env: { ...process.env, OWNER_PASSWORD: PASSWORD }, encoding: 'utf8', maxBuffer: 64 << 20 });
check(sql.status === 0 && sql.stdout.includes('INSERT INTO tickets'), 'the backup turns into restore SQL', sql.stderr);
writeFileSync('restore.sql', sql.stdout);

// A second, empty site: its first request builds the tables (and the starter data the restore replaces).
rmSync('.state2', { recursive: true, force: true });
// The uploaded files back from the link's ZIP into the empty copy's storage (before it starts, as on a new site).
const files = spawnSync('node', ['../../tools/restore-files.mjs', '.linkzip/files', ...(ON_NODE ? ['--dir', '.state2/files'] : ['--bucket', readFileSync('wrangler.jsonc', 'utf8').match(/"bucket_name":\s*"([^"]+)"/)[1], '--local', '--persist-to', '.state2', '-c', 'wrangler.jsonc'])], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
check(files.status === 0 && files.stdout.includes(`restored ${zipFiles.length} of ${zipFiles.length}`), 'the files go back from the ZIP', (files.stderr || files.stdout).slice(-300));
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
    const D = before.data;
    const paths = [
      ...(D.files || []).filter((f) => f.pdf_key).map((f) => `/files/${f.id}/pdf`),
      ...(D.ovr || []).filter((o) => o.photo_key).map((o) => `/ovr/${o.id}/photo`),
      ...(D.inv_files || []).map((f) => `/inv/${f.inv_id}/files/${f.id}`),
      ...(D.committee_files || []).map((f) => `/committees/${f.committee_id}/files/${f.id}`),
    ];
    let same = 0;
    const differ = [];
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
  rmSync('link-backup.zip', { force: true });
  rmSync('.linkzip', { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

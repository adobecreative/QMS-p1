// Restore drill: takes the owner's full backup from the running test site, rebuilds it with
// tools/restore-sql.mjs in a second, empty copy of the site (port 8788), and checks that every
// table comes back the same. Runs after smoke.mjs and systems.mjs, on their data.
// With ON_NODE=1 both copies are the Node.js server (server/node.mjs) and the SQL goes straight into its SQLite file.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

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
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(base + '/api' + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('fm_session=')) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const r = await api('/login', 'POST', { email, password });
  return r.s === 200 ? api : null;
};

const owner = await login(A, 'owner@example.com', 'secret-pass-1');
const before = (await owner('/backup')).j;
check(before && before.kind === 'full' && before.data.tickets.length > 0, 'the owner downloads a full backup with data', before && before.kind);
writeFileSync('restore-backup.json', JSON.stringify(before));

const sql = spawnSync('node', ['../../tools/restore-sql.mjs', 'restore-backup.json'], { env: { ...process.env, OWNER_PASSWORD: PASSWORD }, encoding: 'utf8', maxBuffer: 64 << 20 });
check(sql.status === 0 && sql.stdout.includes('INSERT INTO tickets'), 'the backup turns into restore SQL', sql.stderr);
writeFileSync('restore.sql', sql.stdout);

// A second, empty site: its first request builds the tables (and the starter data the restore replaces).
rmSync('.state2', { recursive: true, force: true });
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
  }
} finally {
  stop();
  rmSync('restore-backup.json', { force: true });
  rmSync('restore.sql', { force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

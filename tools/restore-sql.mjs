// Turns a full backup (the JSON the system owner downloads, or backup.json from the weekly email's ZIP)
// into SQL that rebuilds the data in an empty copy of the system:
//
//   OWNER_PASSWORD='a new password' node tools/restore-sql.mjs backup.json > restore.sql
//   npx wrangler d1 execute <database> --remote --file restore.sql
//
// The backup never holds passwords, so the owner (first account) gets OWNER_PASSWORD and every other
// account must use "Forgot password". Two-step sign-in, sessions, alerts on phones and API keys start
// over too, and employees' old tracking links stop working. PDFs are not in the data: they stay in storage.
import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/auth.js';
import { PBKDF2_ITERATIONS } from '../src/lib/config.js';

const [file] = process.argv.slice(2);
const password = process.env.OWNER_PASSWORD || '';
if (!file || password.length < 8) {
  console.error('usage: OWNER_PASSWORD=<8+ characters> node tools/restore-sql.mjs backup.json > restore.sql');
  process.exit(2);
}
const backup = JSON.parse(readFileSync(file, 'utf8'));
if (backup.app !== 'facilities-tracker' || backup.kind !== 'full' || backup.format !== 1 || !backup.data) {
  console.error('not a full backup (format 1) of this system');
  process.exit(2);
}
const { settings, ...tables } = backup.data;

// No password, so nobody can sign in with it until it is reset (verifyPassword needs "pbkdf2$...").
const NO_PASSWORD = 'reset-required';
const owner = Math.min(...tables.users.map((u) => u.id));
const ownerHash = await hashPassword(password, Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'), PBKDF2_ITERATIONS);
const fill = {
  users: (u) => ({ ...u, password_hash: u.id === owner ? ownerHash : NO_PASSWORD }),
  // Only the hash of each tracking secret was kept by the system, and the backup leaves even that out.
  tickets: (tk) => ({ ...tk, track_hash: 'restored-' + tk.id }),
};

const value = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : `'${String(v).replace(/'/g, "''")}'`);
const out = ['-- Restore of a backup made ' + backup.created_at];
for (const table of Object.keys(tables)) out.push(`DELETE FROM ${table};`);
out.push(`DELETE FROM settings WHERE key NOT IN ('mail_token', 'brevo_key', 'push_vapid');`);
let rows = 0;
for (const [table, list] of Object.entries(tables))
  for (const raw of list) {
    const row = fill[table] ? fill[table](raw) : raw;
    const cols = Object.keys(row);
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => value(row[c])).join(', ')});`);
    rows++;
  }
for (const [key, v] of Object.entries(settings)) out.push(`INSERT OR REPLACE INTO settings (key, value) VALUES (${value(key)}, ${value(v)});`);
process.stdout.write(out.join('\n') + '\n');
console.error(`${Object.keys(tables).length} tables, ${rows} rows, ${Object.keys(settings).length} settings`);

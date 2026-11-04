// Runs a SQL file (such as the restore.sql made by tools/restore-sql.mjs) on the Node.js server's
// database, with the system stopped:  DATA_DIR=/var/lib/portal node server/apply-sql.mjs restore.sql
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
if (!file) {
  console.error('usage: DATA_DIR=... node server/apply-sql.mjs file.sql');
  process.exit(2);
}
const db = new DatabaseSync(join(resolve(process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data')), 'portal.db'));
db.exec(readFileSync(file, 'utf8'));
db.close();
console.log('done');

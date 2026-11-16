// Puts the uploaded files back from the Google Drive copy (the folder "Fikra backups/<site>/files",
// downloaded from Drive and unzipped). Each file's path inside that folder is its storage key.
//
//   Cloudflare R2:      node tools/restore-files.mjs <files folder> --bucket <bucket name>
//   Node.js server:     node tools/restore-files.mjs <files folder> --dir <DATA_DIR>/files
//
// --bucket goes through wrangler (signed in to the account): add --local --persist-to <dir> for a local copy,
// otherwise it writes to the real bucket (--remote). Existing files with the same key are replaced.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const folder = args[0];
const bucket = opt('--bucket');
const dir = opt('--dir');
const local = args.includes('--local');
const persist = opt('--persist-to');
const config = opt('-c');
if (!folder || folder.startsWith('--') || (!bucket && !dir) || (bucket && dir)) {
  console.error('usage: node tools/restore-files.mjs <files folder> (--bucket <name> [--local --persist-to <dir>] [-c wrangler.jsonc] | --dir <DATA_DIR>/files)');
  process.exit(2);
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []));

// Drive does not keep the stored content type in a downloaded ZIP: from the name, else from the first bytes.
const BY_EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg', heic: 'image/heic' };
function contentType(key, bytes) {
  const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (ext && BY_EXT[ext.toLowerCase()]) return BY_EXT[ext.toLowerCase()];
  const head = (n) => bytes.subarray(0, n).toString('latin1');
  if (head(4) === '%PDF') return 'application/pdf';
  if (bytes[0] === 0x89 && head(4).slice(1) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (head(4) === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head(3) === 'GIF') return 'image/gif';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg/i.test(head(200))) return 'image/svg+xml';
  return 'application/octet-stream';
}

const root = resolve(folder);
const files = walk(root);
let done = 0;
let failed = 0;
for (const path of files) {
  const key = relative(root, path).split(sep).join('/');
  const bytes = readFileSync(path);
  const type = contentType(key, bytes);
  if (dir) {
    // The Node.js server keeps each file under DATA_DIR/files with its content type beside it.
    const out = resolve(dir, key);
    if (!out.startsWith(resolve(dir) + sep)) {
      console.error('skipped (bad path): ' + key);
      failed++;
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    writeFileSync(out + '.meta.json', JSON.stringify({ httpMetadata: { contentType: type } }));
  } else {
    const where = local ? ['--local', ...(persist ? ['--persist-to', persist] : [])] : ['--remote'];
    const run = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', path, '--content-type', type, ...where, ...(config ? ['-c', config] : [])], { encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    if (run.status !== 0) {
      console.error('failed: ' + key + '  ' + (run.stderr || run.stdout).trim().split('\n').pop());
      failed++;
      continue;
    }
  }
  done++;
  if (done % 25 === 0) console.error(`${done} / ${files.length}`);
}
console.log(`restored ${done} of ${files.length} file(s)` + (failed ? `, ${failed} failed` : ''));
process.exit(failed ? 1 : 0);

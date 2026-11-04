// Runs the system on an ordinary server with Node.js 22+, without Cloudflare: for hosting inside the
// Kingdom (a Saudi cloud or the customer's own server). The same worker code runs unchanged; only the
// Cloudflare services it uses are replaced here:
//   D1 (database)  -> a SQLite file (node:sqlite, built into Node)
//   R2 (files)     -> a folder on the server's disk, or any S3-compatible storage (server/s3.mjs)
//   static assets  -> the public/ folder
//   cron triggers  -> a timer with the same schedule as wrangler.jsonc
// Workers AI has no stand-in, so the AI assistant stays off on this kind of server.
//
//   LICENSE=PORTAL1... DATA_DIR=/var/lib/portal PORT=8080 node server/node.mjs
//
// Settings (environment variables):
//   PORT          port to listen on (default 8787)
//   HOST          address to listen on (default 0.0.0.0)
//   DATA_DIR      where the database and files are kept (default ./data)
//   LICENSE       the site license, as in wrangler.jsonc vars.LICENSE
//   TRUST_PROXY   1 when behind a reverse proxy (nginx, a load balancer) that sets X-Forwarded-For/-Proto
//   WORKER        the worker module to run (default src/worker.js; the tests use tests/ci/entry.js)
//   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION
//                 set these to keep the files in S3-compatible storage instead of DATA_DIR/files
//                 (the database stays in DATA_DIR either way)
//   TEST_SCHEDULED  1 for the tests only: GET /cdn-cgi/handler/scheduled?cron=&time= runs a cron job now,
//                   as wrangler dev --test-scheduled does. Never set it on a real server.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { s3Files } from './s3.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TEST_SCHEDULED = process.env.TEST_SCHEDULED === '1';
const PUBLIC_DIR = join(ROOT, 'public');
mkdirSync(join(DATA_DIR, 'files'), { recursive: true });

/* ---------------------------- D1 -> SQLite ---------------------------- */

// Same calls and result shapes as D1: prepare().bind().first()/all()/run()/raw(), and batch() in one transaction.
const sqlite = new DatabaseSync(join(DATA_DIR, 'portal.db'));
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
const lastChange = sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id');
// D1 turns true/false into 1/0 and refuses undefined; SQLite here takes neither, so the same is done by hand.
const bindValue = (v) => {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a supported bind value');
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
};
class Statement {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.sql, params.map(bindValue));
  }
  exec() {
    const rows = sqlite.prepare(this.sql).all(...this.params);
    const { changes, last_row_id } = lastChange.get();
    return { results: rows.map((r) => ({ ...r })), success: true, meta: { changes, last_row_id, rows_read: rows.length } };
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first(column) {
    const row = this.exec().results[0];
    if (!row) return null;
    return column === undefined ? row : row[column];
  }
  async raw() {
    return this.exec().results.map((r) => Object.values(r));
  }
}
const DB = {
  prepare: (sql) => new Statement(sql),
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.exec());
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },
  async exec(sql) {
    sqlite.exec(sql);
    return { count: 1, duration: 0 };
  },
};

/* ---------------------------- R2 -> disk ---------------------------- */

// Each object is a file under DATA_DIR/files, with its content type in a small .meta.json beside it.
const FILES_DIR = join(DATA_DIR, 'files');
const META = '.meta.json';
const filePath = (key) => {
  const key2 = String(key);
  const p = resolve(FILES_DIR, key2);
  if (!key2 || key2.endsWith(META) || !p.startsWith(FILES_DIR + sep)) throw new Error('bad file key');
  return p;
};
const toBytes = async (body) => {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
};
const objectOf = async (key, p, withBody) => {
  let info;
  try {
    info = await stat(p);
  } catch {
    return null;
  }
  const meta = await readFile(p + META, 'utf8').then(JSON.parse).catch(() => ({}));
  const obj = { key, size: info.size, uploaded: info.mtime, httpMetadata: meta.httpMetadata || {}, writeHttpMetadata: (h) => meta.httpMetadata?.contentType && h.set('content-type', meta.httpMetadata.contentType) };
  if (!withBody) return obj;
  const bytes = await readFile(p);
  return Object.assign(obj, {
    get body() {
      return new Response(bytes).body;
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  });
};
const walk = async (dir) => {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (!e.name.endsWith(META)) out.push(p);
  }
  return out;
};
const DISK_FILES = {
  async put(key, body, opts = {}) {
    const p = filePath(key);
    await mkdir(dirname(p), { recursive: true });
    const bytes = await toBytes(body);
    await writeFile(p, bytes);
    await writeFile(p + META, JSON.stringify({ httpMetadata: opts.httpMetadata || {} }));
    return objectOf(key, p, false);
  },
  get: async (key) => objectOf(key, filePath(key), true),
  head: async (key) => objectOf(key, filePath(key), false),
  async delete(keys) {
    for (const key of [].concat(keys)) {
      const p = filePath(key);
      await rm(p, { force: true });
      await rm(p + META, { force: true });
    }
  },
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = (await walk(FILES_DIR)).map((p) => relative(FILES_DIR, p).split(sep).join('/')).filter((k) => k.startsWith(prefix)).sort();
    const objects = [];
    for (const key of keys.slice(0, limit)) objects.push(await objectOf(key, filePath(key), false));
    return { objects, truncated: keys.length > limit, delimitedPrefixes: [] };
  },
};

const S3 = process.env.S3_BUCKET;
if (S3 && !(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY)) throw new Error('S3_BUCKET needs S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY');
const FILES = S3 ? s3Files({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', bucket: S3, accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY }) : DISK_FILES;

/* ------------------------- static files (public/) ------------------------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
// Like Cloudflare's assets with "single-page-application": a path that is not a file gets index.html.
const ASSETS = {
  async fetch(input) {
    const req = input instanceof Request ? input : new Request(input);
    let path = decodeURIComponent(new URL(req.url).pathname);
    let p = resolve(PUBLIC_DIR, '.' + path);
    if (!p.startsWith(PUBLIC_DIR)) return new Response('Not found', { status: 404 });
    if (isFile(join(p, 'index.html'))) p = join(p, 'index.html');
    if (!isFile(p)) p = join(PUBLIC_DIR, 'index.html');
    const body = req.method === 'HEAD' ? null : readFileSync(p);
    return new Response(body, { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': extname(p) === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate' } });
  },
};

/* ------------------------------ the worker ------------------------------ */

const worker = (await import(pathToFileURL(resolve(ROOT, process.env.WORKER || 'src/worker.js')).href)).default;
const env = { DB, FILES, ASSETS, LICENSE: process.env.LICENSE || '' };
const context = () => ({
  waitUntil: (p) => Promise.resolve(p).catch((e) => console.error('waitUntil', e)),
  passThroughOnException() {},
});

const server = createServer(async (req, res) => {
  try {
    const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const proto = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.socket.encrypted ? 'https' : 'http';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      // Cloudflare's own headers are set by Cloudflare only; nobody may send them in.
      if (k.startsWith('cf-') || v === undefined) continue;
      for (const one of [].concat(v)) headers.append(k, one);
    }
    headers.set('cf-connecting-ip', forwarded || String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
    if (TEST_SCHEDULED && req.url.startsWith('/cdn-cgi/handler/scheduled')) {
      const q = new URL(req.url, 'http://x').searchParams;
      await worker.scheduled({ cron: q.get('cron') || '*/15 * * * *', scheduledTime: Number(q.get('time')) || Date.now() }, env, context());
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Ran scheduled event');
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`${proto}://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined });
    const response = await worker.fetch(request, env, context());
    const out = {};
    response.headers.forEach((v, k) => {
      if (k !== 'set-cookie') out[k] = v;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    if (!response.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"server_error"}');
  }
});

// The same schedule as wrangler.jsonc: every 15 minutes, and every day at 05:00 UTC.
const CRONS = [
  { cron: '*/15 * * * *', due: (d) => d.getUTCMinutes() % 15 === 0 },
  { cron: '0 5 * * *', due: (d) => d.getUTCHours() === 5 && d.getUTCMinutes() === 0 },
];
let lastTick = Math.floor(Date.now() / 60000);
setInterval(() => {
  const minute = Math.floor(Date.now() / 60000);
  if (minute === lastTick) return;
  lastTick = minute;
  const at = new Date(minute * 60000);
  for (const c of CRONS) if (c.due(at)) worker.scheduled({ cron: c.cron, scheduledTime: at.getTime() }, env, context());
}, 5000).unref();

server.listen(PORT, HOST, () => console.log(`Fikra Portal on http://${HOST}:${PORT} (data in ${DATA_DIR}${S3 ? ', files in S3 bucket ' + S3 : ''})`));
const stop = () => {
  server.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

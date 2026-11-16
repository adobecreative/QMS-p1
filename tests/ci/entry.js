// Automated tests only: the real worker, with the outside services (Workers AI, Brevo, Apps Script)
// replaced by stand-ins. What would have been sent is read back at GET /api/__sent.
import worker from '../../src/worker.js';

const fakeAI = {
  async run() {
    return { response: { category_id: 0 } };
  },
};
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.brevo.com/v3/smtp/email') {
    sent.push({ via: 'brevo', body: JSON.parse(init.body) });
    return Response.json({ messageIds: ['<test@relay>'] }, { status: 201 });
  }
  if (url.startsWith('https://script.google.com/')) {
    const body = JSON.parse(init.body);
    if (String(body.action || '').startsWith('drive_')) return Response.json(fakeDrive(body));
    sent.push({ via: 'gas', body });
    return Response.json({ ok: true });
  }
  return realFetch(input, init);
};
// The Apps Script's Google Drive copy: path -> { type, content (base64) }, under the site's folder.
// GET /api/__drive lists it; GET /api/__drive?path=... gives one file.
const drive = new Map();
function fakeDrive(b) {
  if (b.token !== 'tok-123') return { ok: false, error: 'unauthorized' };
  const root = 'Fikra backups/' + (b.root || 'site') + '/';
  if (b.action === 'drive_check') return { ok: true, drive: true, url: 'https://drive.google.com/test' };
  if (b.action === 'drive_put') {
    drive.set(root + b.path, { type: b.type, content: b.content });
    return { ok: true, drive: true, id: String(drive.size) };
  }
  if (b.action === 'drive_prune') {
    const inFolder = [...drive.keys()].filter((k) => k.startsWith(root + b.folder + '/')).sort().reverse();
    const extra = inFolder.slice(b.keep);
    for (const k of extra) drive.delete(k);
    return { ok: true, drive: true, removed: extra.length };
  }
  return { ok: false, drive: true, error: 'bad_request' };
}
const driveRoute = (req) => {
  const path = new URL(req.url).searchParams.get('path');
  if (!path) return Response.json([...drive].map(([p, f]) => ({ path: p, type: f.type, size: Math.floor((f.content.length * 3) / 4) })));
  const f = drive.get(path);
  return f ? new Response(Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0)), { headers: { 'content-type': f.type } }) : new Response('', { status: 404 });
};
const wrap = (env) => ({ ...env, AI: fakeAI });
export default {
  fetch: (req, env, ctx) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/__sent') return Response.json(sent.splice(0));
    if (path === '/api/__drive') return driveRoute(req);
    return worker.fetch(req, wrap(env), ctx);
  },
  scheduled: (ev, env, ctx) => worker.scheduled(ev, wrap(env), ctx),
};

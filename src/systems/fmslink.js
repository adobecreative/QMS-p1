// The optional link to the Fikra portal (FMS). Off by default: QMS works fully on its own.
// When the owner switches it on, QMS reads the portal's integration API (/api/v1) every hour with a
// read-only key and keeps a small summary: requests, work orders and devices. The summary is shown as
// evidence on the FMS chapter. Nothing is written to the portal and no patient or staff data is kept.
import { readJson } from '../lib/auth.js';
import { isAdmin } from '../lib/config.js';
import { getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { fail, json, nowIso, str, todayIn } from '../lib/util.js';
import { API_KEY_RE } from './api.js';
import { plusDays } from './docs.js';

export const LINK_KEYS = ['link_on', 'link_url', 'link_key', 'link_synced_at', 'link_error', 'link_snapshot', 'link_portal'];
// Calls per sync, so one run stays well inside the free plan's limit on outgoing requests.
const PAGE = 200;
const MAX_PAGES = { recent: 5, assets: 5 };
const TIMEOUT_MS = 10000;

// https only, except a portal on this computer (tests, a server inside the hospital network on http is not allowed).
export function checkPortalUrl(v) {
  let u;
  try {
    u = new URL(String(v || '').trim());
  } catch {
    fail(400, 'link_bad_url');
  }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) fail(400, 'link_bad_url');
  return u.origin;
}

const snapshotOut = (s) => {
  try {
    return s.link_snapshot ? JSON.parse(s.link_snapshot) : null;
  } catch {
    return null;
  }
};
// What every quality user sees on the FMS chapter: the summary, when the link is on.
export const fmsEvidence = (s) => (s.link_on === '1' ? { snapshot: snapshotOut(s), synced_at: s.link_synced_at || null, error: s.link_error || null, portal: s.link_portal || null } : null);

async function call(base, key, path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(base + '/api/v1' + path, { headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, signal: ctrl.signal });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error((body && body.error) || 'http_' + r.status);
      e.status = r.status;
      throw e;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// One sync: read, sum up, keep. Returns what happened; never throws.
export async function runFmsSync(env, actor, force) {
  const s = await getSettings(env);
  if (s.link_on !== '1' || !s.link_url || !s.link_key) return { ok: true, skipped: true };
  // Once an hour from the 15-minute timer; "Sync now" runs at once.
  if (!force && s.link_synced_at && Date.now() - Date.parse(s.link_synced_at) < 55 * 60000) return { ok: true, skipped: true };
  const today = todayIn(s.timezone);
  const now = nowIso();
  try {
    const ping = await call(s.link_url, s.link_key, '/ping');
    const scopes = ping.scopes || [];
    const snap = { at: now, today, scopes };
    if (scopes.includes('tickets_read')) {
      // Open requests, newest first. A hospital rarely has more than a few hundred open at once;
      // past one page the count is shown as "200+".
      const first = await call(s.link_url, s.link_key, `/tickets?status=open&limit=${PAGE}`);
      const open = first.tickets;
      let more = true;
      const recent = [];
      let since = plusDays(today, -30) + 'T00:00:00.000Z';
      for (let page = 0; more && page < MAX_PAGES.recent; page++) {
        const r = await call(s.link_url, s.link_key, `/tickets?status=closed&since=${encodeURIComponent(since)}&limit=${PAGE}`);
        recent.push(...r.tickets);
        more = r.more && r.tickets.length > 0;
        if (r.tickets.length) since = r.tickets[r.tickets.length - 1].updated_at;
      }
      const closed = recent.filter((t) => t.closed_at && t.closed_at.slice(0, 10) >= plusDays(today, -30));
      const timed = closed.filter((t) => t.sla_met === true || t.sla_met === false);
      snap.tickets = {
        open: open.length,
        open_partial: !!first.more,
        late: open.filter((t) => t.late).length,
        patient_impact: open.filter((t) => t.patient_impact).length,
        closed_30: closed.length,
        work_orders_30: closed.filter((t) => t.work_order).length,
        sla_pct: timed.length ? Math.round((timed.filter((t) => t.sla_met).length / timed.length) * 100) : null,
        rating: (() => {
          const r = closed.map((t) => t.rating).filter((x) => typeof x === 'number');
          return r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10 : null;
        })(),
      };
    }
    if (scopes.includes('assets_read')) {
      const all = [];
      let after = 0;
      let more = true;
      for (let page = 0; more && page < MAX_PAGES.assets; page++) {
        const r = await call(s.link_url, s.link_key, `/assets?limit=${PAGE}${after ? '&after_id=' + after : ''}`);
        all.push(...r.assets);
        more = r.more && r.assets.length > 0;
        if (r.assets.length) after = r.assets[r.assets.length - 1].id;
      }
      const live = all.filter((a) => a.status !== 'retired');
      const withPm = live.filter((a) => a.next_pm);
      const overdue = withPm.filter((a) => a.next_pm < today).length;
      snap.assets = {
        total: live.length,
        partial: all.length >= PAGE * MAX_PAGES.assets,
        out_of_service: live.filter((a) => a.status === 'out_of_service').length,
        high_risk: live.filter((a) => a.risk === 'high').length,
        pm_planned: withPm.length,
        pm_overdue: overdue,
        pm_pct: withPm.length ? Math.round(((withPm.length - overdue) / withPm.length) * 100) : null,
        open_faults: live.reduce((n, a) => n + (a.open_faults || 0), 0),
      };
    }
    // Shown beside the evidence: where it came from (the ping answers with the key's name, not the portal's).
    const host = new URL(s.link_url).hostname;
    const portal = JSON.stringify({ name_ar: host, name_en: host });
    await env.DB.batch([
      setSettingStmt(env, 'link_snapshot', JSON.stringify(snap)),
      setSettingStmt(env, 'link_synced_at', now),
      setSettingStmt(env, 'link_error', ''),
      setSettingStmt(env, 'link_portal', portal),
      env.DB.prepare('INSERT OR REPLACE INTO fms_snapshots (day, data) VALUES (?, ?)').bind(today, JSON.stringify(snap)),
    ]);
    return { ok: true, snapshot: snap };
  } catch (e) {
    const code = e.name === 'AbortError' ? 'link_timeout' : e.status === 401 ? 'link_bad_key' : e.status ? 'link_http_' + e.status : 'link_unreachable';
    // The last good summary stays on screen, marked with the error, so a short outage changes nothing.
    await env.DB.batch([setSettingStmt(env, 'link_error', code), setSettingStmt(env, 'link_synced_at', now), logStmt(env, actor, 'sync_failed', 'fms_link', null, null, { error: code })]);
    return { ok: false, error: code };
  }
}

export async function handleFmsLink(request, env, seg, method, user, isOwner) {
  if (!isAdmin(user) || !isOwner) fail(403, 'forbidden');
  const s = await getSettings(env);
  const out = (x) => ({ on: x.link_on === '1', url: x.link_url || '', key_set: !!x.link_key, synced_at: x.link_synced_at || null, error: x.link_error || null, snapshot: snapshotOut(x), portal: x.link_portal ? JSON.parse(x.link_portal) : null });
  const route = `${method} /${seg.join('/')}`;
  if (route === 'GET /fms-link') return json(out(s));
  if (route === 'PUT /fms-link') {
    const body = await readJson(request);
    const on = body.on ? '1' : '0';
    const url = body.url ? checkPortalUrl(body.url) : s.link_url || '';
    const key = str(body.key, 60);
    if (key && !API_KEY_RE.test(key)) fail(400, 'link_bad_key_format');
    if (on === '1' && (!url || !(key || s.link_key))) fail(400, 'link_needs_url_key');
    const stmts = [setSettingStmt(env, 'link_on', on), setSettingStmt(env, 'link_url', url)];
    if (key) stmts.push(setSettingStmt(env, 'link_key', key));
    // Switching the link off forgets the key and the summary: nothing of the portal stays behind.
    if (on === '0') for (const k of ['link_key', 'link_snapshot', 'link_error', 'link_synced_at', 'link_portal']) stmts.push(setSettingStmt(env, k, ''));
    stmts.push(logStmt(env, user, 'update', 'fms_link', null, url, { link_on: [s.link_on || '0', on], ...(key ? { link_key: ['***', '***'] } : {}) }));
    await env.DB.batch(stmts);
    // A first sync straight away, so the owner sees at once whether the address and key work.
    const sync = on === '1' ? await runFmsSync(env, user, true) : null;
    return json({ ...out(await getSettings(env)), sync });
  }
  if (route === 'POST /fms-link/sync') return json(await runFmsSync(env, user, true));
  fail(405, 'method_not_allowed');
}

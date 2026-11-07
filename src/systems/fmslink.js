// The optional link to the Fikra portal (FMS). Off by default: QMS works fully on its own.
// When the owner switches it on, QMS reads the portal's integration API (/api/v1) every hour with a
// read-only key and keeps a small summary: requests, work orders and devices. The summary is shown as
// evidence on the FMS chapter. Nothing is written to the portal and no patient or staff data is kept.
import { readJson } from '../lib/auth.js';
import { isAdmin } from '../lib/config.js';
import { getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { fail, json, nowIso, sha256Hex, str, todayIn } from '../lib/util.js';
import { API_KEY_RE } from './api.js';
import { plusDays } from './docs.js';
import { importStaff } from './tickets.js';

export const LINK_KEYS = ['link_on', 'link_url', 'link_key', 'link_synced_at', 'link_error', 'link_snapshot', 'link_portal', 'link_staff_hash'];
// Calls per sync, so one run stays well inside the free plan's limit on outgoing requests.
const PAGE = 200;
const MAX_PAGES = { recent: 5, assets: 5, docs: 10 };
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
    // The document register: kept here so it can be filed under chapters; the PDFs stay in the portal.
    const extra = [];
    if (scopes.includes('docs_read')) {
      const all = [];
      let after = 0;
      let more = true;
      for (let page = 0; more && page < MAX_PAGES.docs; page++) {
        const r = await call(s.link_url, s.link_key, `/documents?limit=${PAGE}${after ? '&after_id=' + after : ''}`);
        all.push(...r.documents);
        more = r.more && r.documents.length > 0;
        if (r.documents.length) after = r.documents[r.documents.length - 1].id;
      }
      const rows = all.map((d) => ({
        id: d.id, file_number: str(d.file_number, 60), name_ar: str(d.name_ar, 200) || str(d.name_en, 200) || '#' + d.id, name_en: str(d.name_en, 200), doc_type: str(d.doc_type, 20),
        type_ar: str(d.type_ar, 100), type_en: str(d.type_en, 100), department_ar: str(d.department_ar, 100), department_en: str(d.department_en, 100),
        issue_date: str(d.issue_date, 10) || null, expiry_date: str(d.expiry_date, 10) || null, status: str(d.status, 10), has_pdf: d.has_pdf ? 1 : 0, updated_at: str(d.updated_at, 40),
      }));
      // One statement for the whole register (the free plan counts queries, not rows); the chapter is kept.
      extra.push(
        env.DB.prepare(
          `INSERT INTO portal_docs (id, file_number, name_ar, name_en, doc_type, type_ar, type_en, department_ar, department_en, issue_date, expiry_date, status, has_pdf, updated_at, synced_at)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.file_number'), json_extract(value, '$.name_ar'), json_extract(value, '$.name_en'), json_extract(value, '$.doc_type'),
                  json_extract(value, '$.type_ar'), json_extract(value, '$.type_en'), json_extract(value, '$.department_ar'), json_extract(value, '$.department_en'),
                  json_extract(value, '$.issue_date'), json_extract(value, '$.expiry_date'), json_extract(value, '$.status'), json_extract(value, '$.has_pdf'), json_extract(value, '$.updated_at'), ?2
             FROM json_each(?1) WHERE true
           ON CONFLICT(id) DO UPDATE SET file_number = excluded.file_number, name_ar = excluded.name_ar, name_en = excluded.name_en, doc_type = excluded.doc_type, type_ar = excluded.type_ar,
                  type_en = excluded.type_en, department_ar = excluded.department_ar, department_en = excluded.department_en, issue_date = excluded.issue_date, expiry_date = excluded.expiry_date,
                  status = excluded.status, has_pdf = excluded.has_pdf, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
        ).bind(JSON.stringify(rows), now),
      );
      // A document deleted in the portal goes here too, unless the register was too long to read in full.
      if (!more) extra.push(env.DB.prepare('DELETE FROM portal_docs WHERE synced_at <> ?').bind(now));
      snap.docs = { total: rows.length, partial: more, expired: rows.filter((d) => d.status === 'expired').length, near: rows.filter((d) => d.status === 'near').length };
    }
    // Staff: the portal's list fills the staff here (committee members are picked from it). Departments are
    // matched by name, because each system numbers its own. Nobody is switched off here who is not off there.
    if (scopes.includes('staff')) {
      const [{ departments: pdeps }, { staff }] = await Promise.all([call(s.link_url, s.link_key, '/departments'), call(s.link_url, s.link_key, '/staff')]);
      const { results: mine } = await env.DB.prepare('SELECT id, name_ar, name_en FROM departments').all();
      const norm = (v) => String(v || '').trim().toLowerCase();
      const byName = new Map();
      for (const d of mine) for (const n of [d.name_ar, d.name_en]) if (n) byName.set(norm(n), d.id);
      const deptOf = new Map((pdeps || []).map((d) => [d.id, byName.get(norm(d.name_ar)) || byName.get(norm(d.name_en)) || null]));
      const rows = (staff || []).map((m) => ({ emp_no: m.emp_no, name: m.name, name_en: m.name_en, department_id: deptOf.get(m.department_id) || null, phone: m.phone, active: m.active }));
      // Only when the list changed, so the activity log is not filled with the same import every hour.
      const hash = await sha256Hex(JSON.stringify(rows));
      if (hash !== s.link_staff_hash) {
        await importStaff(env, actor, rows);
        extra.push(setSettingStmt(env, 'link_staff_hash', hash));
      }
      snap.staff = { total: rows.length, matched: rows.filter((m) => m.department_id).length };
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
      ...extra,
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
    if (on === '0') for (const k of ['link_key', 'link_snapshot', 'link_error', 'link_synced_at', 'link_portal', 'link_staff_hash']) stmts.push(setSettingStmt(env, k, ''));
    // The portal's document register goes with it; the staff stay (they are this system's staff now).
    if (on === '0') stmts.push(env.DB.prepare('DELETE FROM portal_docs'));
    stmts.push(logStmt(env, user, 'update', 'fms_link', null, url, { link_on: [s.link_on || '0', on], ...(key ? { link_key: ['***', '***'] } : {}) }));
    await env.DB.batch(stmts);
    // A first sync straight away, so the owner sees at once whether the address and key work.
    const sync = on === '1' ? await runFmsSync(env, user, true) : null;
    return json({ ...out(await getSettings(env)), sync });
  }
  if (route === 'POST /fms-link/sync') return json(await runFmsSync(env, user, true));
  fail(405, 'method_not_allowed');
}

/* ---- the portal's documents, read over the link ---- */

// Who sees them: anyone with a documents or quality role. Who files them under a chapter: a quality manager
// or a documents admin. The PDF is fetched from the portal for each opening and never kept here.
const has = (r) => !!r && r !== 'none';
export const portalDocsOn = (s) => s.link_on === '1' && !!(snapshotOut(s)?.scopes || []).includes('docs_read');
export const portalDocUrl = (id) => '/api/portal-docs/' + id + '/pdf';

export async function handlePortalDocs(request, env, seg, method, user) {
  if (!has(user.docs) && !has(user.quality) && !isAdmin(user)) fail(403, 'forbidden');
  const s = await getSettings(env);
  const canFile = isAdmin(user) || user.quality === 'manager' || user.docs === 'admin';
  const id = /^\d+$/.test(seg[1] || '') ? Number(seg[1]) : null;
  if (method === 'GET' && seg.length === 1) {
    const [{ results }, { results: chapters }] = await Promise.all([
      env.DB.prepare('SELECT * FROM portal_docs ORDER BY doc_type, name_ar').all(),
      env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' ORDER BY sort, code").all(),
    ]);
    const host = s.link_url ? new URL(s.link_url).hostname : null;
    return json({ on: portalDocsOn(s), portal: host, synced_at: s.link_synced_at || null, error: s.link_error || null, can_file: canFile, chapters, docs: results.map((d) => ({ ...d, has_pdf: !!d.has_pdf, pdf_url: portalDocUrl(d.id) })) });
  }
  if (method === 'PUT' && id && seg.length === 2) {
    if (!canFile) fail(403, 'forbidden');
    const body = await readJson(request);
    const chapter = str(body.chapter, 6).toUpperCase() || null;
    if (chapter && !(await env.DB.prepare("SELECT 1 FROM std_chapters WHERE framework = 'cbahi' AND code = ?").bind(chapter).first())) fail(400, 'std_bad_chapter');
    const d = await env.DB.prepare('SELECT name_ar, chapter FROM portal_docs WHERE id = ?').bind(id).first();
    if (!d) fail(404, 'not_found');
    await env.DB.batch([
      env.DB.prepare('UPDATE portal_docs SET chapter = ? WHERE id = ?').bind(chapter, id),
      logStmt(env, user, 'update', 'portal_doc', id, d.name_ar, { chapter: [d.chapter, chapter] }),
    ]);
    return json({ ok: true });
  }
  if (method === 'GET' && id && seg[2] === 'pdf' && seg.length === 3) {
    if (!portalDocsOn(s) || !s.link_key) fail(404, 'not_found');
    if (!(await env.DB.prepare('SELECT 1 FROM portal_docs WHERE id = ? AND has_pdf = 1').bind(id).first())) fail(404, 'not_found');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(s.link_url + '/api/v1/documents/' + id + '/pdf', { headers: { authorization: 'Bearer ' + s.link_key }, signal: ctrl.signal });
      if (!r.ok || !String(r.headers.get('content-type') || '').startsWith('application/pdf')) fail(r.status === 404 ? 404 : 502, r.status === 404 ? 'not_found' : 'link_unreachable');
      const bytes = await r.arrayBuffer();
      return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
    } catch (e) {
      if (e.status) throw e;
      fail(502, 'link_unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
  fail(405, 'method_not_allowed');
}

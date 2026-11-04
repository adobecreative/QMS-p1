// Suppliers and contracts, their papers and the contract reminders.
import { readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { checkLang, diffDays, escHtml, fail, json, nowIso, optDate, str, todayIn } from '../lib/util.js';
import { route2 } from './assets.js';
import { plusDays, readPdf } from './docs.js';
import { CONTRACT_TEXT } from './inventory.js';
import { addMinutes, toInt } from './tickets.js';

/* ------------------------- Contracts and suppliers ------------------------ */

// Part of Asset Management: suppliers with their papers (each with an expiry date), contracts with the
// assets they cover, the planned visits they promise, the time a supplier must arrive in, and the penalty
// for arriving late. A request sent to a supplier records when it was sent and when the supplier came.
export const VENDOR_DOC_KINDS = ['cr', 'zakat', 'gosi', 'sfda', 'insurance', 'other'];
export const CONTRACT_KINDS = ['comprehensive', 'labor', 'parts', 'warranty', 'service'];
export const CONTRACT_ALERTS = [90, 60, 30]; // days before a contract ends
export const DOC_ALERTS = [30, 0]; // days before a supplier's paper expires, and the day it does
export const CONTRACT_ASSETS_MAX = 500;
export const CONTRACT_EN = ['cr_no', 'vat_no', 'number', 'email', 'phone'];

// active | upcoming | ending (90 days or less left) | expired | renewed (a newer contract carries it on)
export function contractState(c, today) {
  if (c.renewed_by) return 'renewed';
  if (c.end_date < today) return 'expired';
  if (c.start_date > today) return 'upcoming';
  return diffDays(c.end_date, today) <= CONTRACT_ALERTS[0] ? 'ending' : 'active';
}

// Planned visits: the year's number spread evenly over the contract. due = how many should be done by today.
export function visitFigures(c, done, today) {
  const span = Math.max(1, diffDays(c.end_date, c.start_date) + 1);
  const total = c.visits_per_year ? Math.max(1, Math.round((c.visits_per_year * span) / 365)) : 0;
  const passed = Math.min(span, Math.max(0, diffDays(today, c.start_date) + 1));
  const due = total ? Math.min(total, Math.floor((total * passed) / span)) : 0;
  return { total, due, done, behind: Math.max(0, due - done) };
}

// How late a supplier was: minutes past the agreed time, and the penalty for it (each started hour counts).
export function vendorLate(t, contract, now) {
  if (!t.vendor_called_at || !contract || !contract.response_hours) return { late_min: 0, penalty: 0, due_at: null };
  const dueAt = addMinutes(t.vendor_called_at, contract.response_hours * 60);
  const end = t.vendor_arrived_at || (t.status === 'closed' ? t.closed_at : now);
  const late = Math.max(0, Math.round((Date.parse(end) - Date.parse(dueAt)) / 60000));
  return { late_min: late, penalty: late && contract.penalty_per_hour ? Math.ceil(late / 60) * contract.penalty_per_hour : 0, due_at: dueAt };
}

// The penalties of one contract never go past its cap (a share of the contract's value).
export const capPenalty = (sum, c) => (c.penalty_cap_pct && c.value ? Math.min(sum, Math.round(c.value * c.penalty_cap_pct) / 100) : sum);

export const CONTRACT_SELECT = `SELECT c.*, v.name_ar AS vendor_ar, v.name_en AS vendor_en,
       (SELECT n.id FROM contracts n WHERE n.prev_id = c.id LIMIT 1) AS renewed_by,
       (SELECT COUNT(*) FROM contract_assets ca WHERE ca.contract_id = c.id) AS asset_count,
       (SELECT COUNT(*) FROM contract_visits cv WHERE cv.contract_id = c.id) AS visits_done
  FROM contracts c JOIN vendors v ON v.id = c.vendor_id`;

export function contractOut(c, today) {
  const { pdf_key, alert_level, ...rest } = c;
  return { ...rest, has_pdf: !!pdf_key, state: contractState(c, today), days_left: diffDays(c.end_date, today), visits: visitFigures(c, c.visits_done || 0, today) };
}
export const vendorDocOut = (d, today) => {
  const { file_key, alert_level, ...rest } = d;
  return { ...rest, has_file: !!file_key, days_left: d.expiry_date ? diffDays(d.expiry_date, today) : null };
};

export const num = (v, max) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) fail(400, 'invalid_number');
  return n;
};

export function readVendor(body) {
  checkLang((k) => body[k], [], CONTRACT_EN);
  const email = str(body.email, 200).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email');
  const next = {
    name_ar: str(body.name_ar, 150),
    name_en: str(body.name_en, 150),
    cr_no: str(body.cr_no, 30) || null,
    vat_no: str(body.vat_no, 30) || null,
    contact_name: str(body.contact_name, 100) || null,
    phone: str(body.phone, 30) || null,
    email: email || null,
    services: str(body.services, 300) || null,
    notes: str(body.notes, 2000) || null,
    active: body.active === false ? 0 : 1,
  };
  if (!next.name_ar || !next.name_en) fail(400, 'name_required');
  return next;
}
export const VENDOR_KEYS = ['name_ar', 'name_en', 'cr_no', 'vat_no', 'contact_name', 'phone', 'email', 'services', 'notes', 'active'];

export function readContract(body) {
  checkLang((k) => body[k], ['title_ar'], [...CONTRACT_EN, 'title_en']);
  const next = {
    vendor_id: toInt(body.vendor_id),
    number: str(body.number, 50),
    title_ar: str(body.title_ar, 200),
    title_en: str(body.title_en, 200),
    kind: CONTRACT_KINDS.includes(body.kind) ? body.kind : null,
    start_date: optDate(body.start_date),
    end_date: optDate(body.end_date),
    value: num(body.value, 1e10),
    response_hours: num(body.response_hours, 720),
    visits_per_year: num(body.visits_per_year, 365),
    penalty_per_hour: num(body.penalty_per_hour, 1e8),
    penalty_cap_pct: num(body.penalty_cap_pct, 100),
    notes: str(body.notes, 3000) || null,
  };
  if (!next.vendor_id) fail(400, 'vendor_required');
  if (!next.number) fail(400, 'contract_number_required');
  if (!next.title_ar || !next.title_en) fail(400, 'name_required');
  if (!next.kind) fail(400, 'invalid_kind');
  if (!next.start_date || !next.end_date) fail(400, 'invalid_date');
  if (next.end_date < next.start_date) fail(400, 'end_before_start');
  if (next.visits_per_year !== null) next.visits_per_year = Math.round(next.visits_per_year);
  if (next.response_hours !== null) next.response_hours = Math.round(next.response_hours * 100) / 100;
  return next;
}
export const CONTRACT_KEYS = ['vendor_id', 'number', 'title_ar', 'title_en', 'kind', 'start_date', 'end_date', 'value', 'response_hours', 'visits_per_year', 'penalty_per_hour', 'penalty_cap_pct', 'notes'];

export const pdfResponse = (obj, name) =>
  new Response(obj.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(obj.size),
      // The name is only ever shown by the browser; quotes and line breaks are taken out.
      'content-disposition': `inline; filename="${String(name || 'file.pdf').replace(/[^\w.\- ]+/g, '_')}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });

export async function handleContracts(request, env, url, seg, method, user) {
  const role = user.assets;
  // Technicians open the supplier list from a request, to send it to a supplier.
  const pick = seg[0] === 'vendors' && seg[1] === 'pick' && method === 'GET';
  if (role === 'none' && !(pick && user.desk !== 'none')) fail(403, 'forbidden');
  const manager = role === 'admin' || role === 'manager';
  const needManager = () => {
    if (!manager) fail(403, 'forbidden');
  };
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const route = route2(method, seg);

  if (pick) {
    const [{ results: vendors }, { results: contracts }] = await Promise.all([
      env.DB.prepare('SELECT id, name_ar, name_en, phone FROM vendors WHERE active = 1 ORDER BY name_ar').all(),
      env.DB.prepare('SELECT id, vendor_id, number, title_ar, title_en, response_hours FROM contracts WHERE start_date <= ?1 AND end_date >= ?1 ORDER BY end_date').bind(today).all(),
    ]);
    return json({ vendors: vendors.map((v) => ({ ...v, contracts: contracts.filter((c) => c.vendor_id === v.id) })) });
  }

  /* ---- suppliers ---- */

  if (route === 'GET /vendors') {
    const [{ results: vendors }, { results: docs }, { results: contracts }] = await Promise.all([
      env.DB.prepare('SELECT * FROM vendors ORDER BY name_ar').all(),
      env.DB.prepare('SELECT vendor_id, expiry_date FROM vendor_docs WHERE expiry_date IS NOT NULL').all(),
      env.DB.prepare('SELECT vendor_id, end_date, start_date FROM contracts WHERE end_date >= ?').bind(today).all(),
    ]);
    return json({
      vendors: vendors.map((v) => {
        const mine = docs.filter((d) => d.vendor_id === v.id);
        return {
          ...v,
          docs_expired: mine.filter((d) => d.expiry_date < today).length,
          docs_near: mine.filter((d) => d.expiry_date >= today && diffDays(d.expiry_date, today) <= DOC_ALERTS[0]).length,
          active_contracts: contracts.filter((c) => c.vendor_id === v.id && c.start_date <= today).length,
        };
      }),
      today,
      can_manage: manager,
    });
  }
  if (route === 'POST /vendors') {
    needManager();
    const next = readVendor(await readJson(request));
    const now = nowIso();
    const res = await env.DB.prepare(`INSERT INTO vendors (${VENDOR_KEYS.join(', ')}, created_at, updated_at) VALUES (${VENDOR_KEYS.map(() => '?').join(', ')}, ?, ?)`)
      .bind(...VENDOR_KEYS.map((k) => next[k]), now, now)
      .run();
    await logStmt(env, user, 'create', 'vendor', res.meta.last_row_id, next.name_ar).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  if (seg[0] === 'vendors' && id !== null) {
    const vendor = await env.DB.prepare('SELECT * FROM vendors WHERE id = ?').bind(id).first();
    if (!vendor) fail(404, 'not_found');

    // One supplier: its papers, its contracts and how well it kept to them.
    if (method === 'GET' && seg.length === 2) {
      const [{ results: docs }, { results: contracts }, { results: tickets }] = await Promise.all([
        env.DB.prepare('SELECT * FROM vendor_docs WHERE vendor_id = ? ORDER BY expiry_date IS NULL, expiry_date').bind(id).all(),
        env.DB.prepare(CONTRACT_SELECT + ' WHERE c.vendor_id = ? ORDER BY c.end_date DESC').bind(id).all(),
        env.DB.prepare(
          `SELECT t.id, t.status, t.description, t.created_at, t.closed_at, t.contract_id, t.vendor_called_at, t.vendor_arrived_at, a.tag AS asset_tag, a.name_ar AS asset_ar, a.name_en AS asset_en
             FROM tickets t LEFT JOIN assets a ON a.id = t.asset_id WHERE t.vendor_id = ? ORDER BY t.id DESC LIMIT 500`,
        ).bind(id).all(),
      ]);
      const now = nowIso();
      const byId = new Map(contracts.map((c) => [c.id, c]));
      const rows = tickets.map((t) => ({ ...t, ...vendorLate(t, byId.get(t.contract_id), now) }));
      const arrived = rows.filter((t) => t.vendor_arrived_at);
      const timed = arrived.filter((t) => byId.get(t.contract_id) && byId.get(t.contract_id).response_hours);
      const perContract = new Map();
      for (const t of rows) if (t.penalty) perContract.set(t.contract_id, (perContract.get(t.contract_id) || 0) + t.penalty);
      const penalties = [...perContract].reduce((s, [cid, sum]) => s + capPenalty(sum, byId.get(cid)), 0);
      return json({
        vendor,
        docs: docs.map((d) => vendorDocOut(d, today)),
        contracts: contracts.map((c) => ({ ...contractOut(c, today), penalties: capPenalty(perContract.get(c.id) || 0, c) })),
        tickets: rows,
        stats: {
          sent: rows.length,
          arrived: arrived.length,
          avg_arrive_min: arrived.length ? Math.round(arrived.reduce((s, t) => s + (Date.parse(t.vendor_arrived_at) - Date.parse(t.vendor_called_at)) / 60000, 0) / arrived.length) : null,
          on_time: timed.length ? timed.filter((t) => !t.late_min).length : null,
          timed: timed.length,
          penalties,
        },
        today,
        can_manage: manager,
      });
    }
    if (method === 'PUT' && seg.length === 2) {
      needManager();
      const next = readVendor(await readJson(request));
      await env.DB.batch([
        env.DB.prepare(`UPDATE vendors SET ${VENDOR_KEYS.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...VENDOR_KEYS.map((k) => next[k]), nowIso(), id),
        logStmt(env, user, 'update', 'vendor', id, next.name_ar, changes(vendor, next, VENDOR_KEYS)),
      ]);
      return json({ ok: true });
    }
    // A supplier with contracts or requests stays in the record: it can be switched off instead.
    if (method === 'DELETE' && seg.length === 2) {
      needManager();
      const used = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM contracts WHERE vendor_id = ?1) + (SELECT COUNT(*) FROM tickets WHERE vendor_id = ?1) AS n').bind(id).first();
      if (used.n > 0) fail(409, 'vendor_in_use');
      const { results: docs } = await env.DB.prepare('SELECT file_key FROM vendor_docs WHERE vendor_id = ? AND file_key IS NOT NULL').bind(id).all();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM vendor_docs WHERE vendor_id = ?').bind(id),
        env.DB.prepare('DELETE FROM vendors WHERE id = ?').bind(id),
        logStmt(env, user, 'delete', 'vendor', id, vendor.name_ar),
      ]);
      for (const d of docs) await env.FILES.delete(d.file_key);
      return json({ ok: true });
    }
    // A paper: its kind, number, expiry date and (optional) PDF, sent as a form.
    if (method === 'POST' && seg[2] === 'docs' && seg.length === 3) {
      needManager();
      const form = await request.formData().catch(() => fail(400, 'bad_request'));
      checkLang((k) => form.get(k), [], ['number']);
      const kind = VENDOR_DOC_KINDS.includes(form.get('kind')) ? form.get('kind') : null;
      if (!kind) fail(400, 'invalid_kind');
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM vendor_docs WHERE vendor_id = ?').bind(id).first();
      if (count.n >= 50) fail(409, 'too_many_docs');
      const number = str(form.get('number'), 50) || null;
      const note = str(form.get('note'), 300) || null;
      const expiry = optDate(form.get('expiry_date'));
      const pdf = await readPdf(form);
      const key = pdf ? `vendor/${crypto.randomUUID()}.pdf` : null;
      if (pdf) await env.FILES.put(key, pdf.bytes, { httpMetadata: { contentType: 'application/pdf' } });
      try {
        const now = nowIso();
        const res = await env.DB.prepare('INSERT INTO vendor_docs (vendor_id, kind, number, note, expiry_date, file_key, file_name, file_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, kind, number, note, expiry, key, pdf ? pdf.name : null, pdf ? pdf.size : null, now, now)
          .run();
        await logStmt(env, user, 'create', 'vendor_doc', res.meta.last_row_id, vendor.name_ar, { kind: [null, kind], expiry_date: [null, expiry] }).run();
        return json({ ok: true, id: res.meta.last_row_id });
      } catch (e) {
        if (key) await env.FILES.delete(key);
        throw e;
      }
    }
    fail(404, 'not_found');
  }

  if (seg[0] === 'vendor-docs' && id !== null) {
    const doc = await env.DB.prepare('SELECT d.*, v.name_ar AS vendor_ar FROM vendor_docs d JOIN vendors v ON v.id = d.vendor_id WHERE d.id = ?').bind(id).first();
    if (!doc) fail(404, 'not_found');
    if (method === 'GET' && seg[2] === 'file' && seg.length === 3) {
      const obj = doc.file_key ? await env.FILES.get(doc.file_key) : null;
      if (!obj) fail(404, 'not_found');
      return pdfResponse(obj, doc.file_name);
    }
    if (method === 'DELETE' && seg.length === 2) {
      needManager();
      await env.DB.batch([env.DB.prepare('DELETE FROM vendor_docs WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'vendor_doc', id, doc.vendor_ar, { kind: [doc.kind, null] })]);
      if (doc.file_key) await env.FILES.delete(doc.file_key);
      return json({ ok: true });
    }
    fail(404, 'not_found');
  }

  /* ---- contracts ---- */

  if (route === 'GET /contracts') {
    const [{ results: contracts }, { results: vendors }, { results: uncovered }] = await Promise.all([
      env.DB.prepare(CONTRACT_SELECT + ' ORDER BY c.end_date').all(),
      env.DB.prepare('SELECT id, name_ar, name_en, active FROM vendors ORDER BY name_ar').all(),
      // High-risk assets in service with no contract running today.
      env.DB.prepare(
        `SELECT a.id, a.tag, a.name_ar, a.name_en FROM assets a
          WHERE a.risk = 'high' AND a.status = 'in_service'
            AND NOT EXISTS (SELECT 1 FROM contract_assets ca JOIN contracts c ON c.id = ca.contract_id WHERE ca.asset_id = a.id AND c.start_date <= ?1 AND c.end_date >= ?1)
          ORDER BY a.tag LIMIT 200`,
      ).bind(today).all(),
    ]);
    return json({ contracts: contracts.map((c) => contractOut(c, today)), vendors, uncovered, today, can_manage: manager });
  }
  if (route === 'POST /contracts') {
    needManager();
    const next = readContract(await readJson(request));
    if (!(await env.DB.prepare('SELECT id FROM vendors WHERE id = ?').bind(next.vendor_id).first())) fail(400, 'vendor_required');
    const now = nowIso();
    const res = await env.DB.prepare(`INSERT INTO contracts (${CONTRACT_KEYS.join(', ')}, created_at, updated_at) VALUES (${CONTRACT_KEYS.map(() => '?').join(', ')}, ?, ?)`)
      .bind(...CONTRACT_KEYS.map((k) => next[k]), now, now)
      .run();
    await logStmt(env, user, 'create', 'contract', res.meta.last_row_id, `${next.title_ar} (${next.number})`, { end_date: [null, next.end_date] }).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  if (seg[0] === 'contracts' && id !== null) {
    const c = await env.DB.prepare(CONTRACT_SELECT + ' WHERE c.id = ?').bind(id).first();
    if (!c) fail(404, 'not_found');
    const label = `${c.title_ar} (${c.number})`;

    if (method === 'GET' && seg.length === 2) {
      const [{ results: assets }, { results: visits }, { results: tickets }, { results: history }] = await Promise.all([
        env.DB.prepare(
          `SELECT a.id, a.tag, a.name_ar, a.name_en, a.status, a.risk, l.name_ar AS loc_ar, l.name_en AS loc_en
             FROM contract_assets ca JOIN assets a ON a.id = ca.asset_id LEFT JOIN locations l ON l.id = a.location_id WHERE ca.contract_id = ? ORDER BY a.tag`,
        ).bind(id).all(),
        env.DB.prepare('SELECT * FROM contract_visits WHERE contract_id = ? ORDER BY done_on DESC, id DESC').bind(id).all(),
        env.DB.prepare(
          `SELECT t.id, t.status, t.description, t.created_at, t.closed_at, t.vendor_called_at, t.vendor_arrived_at, a.tag AS asset_tag
             FROM tickets t LEFT JOIN assets a ON a.id = t.asset_id WHERE t.contract_id = ? ORDER BY t.id DESC LIMIT 500`,
        ).bind(id).all(),
        // Every contract before and after this one in the same line of renewals.
        env.DB.prepare(
          `WITH RECURSIVE up(id, prev_id) AS (SELECT id, prev_id FROM contracts WHERE id = ?1 UNION SELECT c.id, c.prev_id FROM contracts c JOIN up ON c.id = up.prev_id),
                          down(id) AS (SELECT id FROM contracts WHERE id = ?1 UNION SELECT c.id FROM contracts c JOIN down ON c.prev_id = down.id)
           SELECT id, number, start_date, end_date, value, prev_id FROM contracts WHERE id IN (SELECT id FROM up UNION SELECT id FROM down) ORDER BY start_date`,
        ).bind(id).all(),
      ]);
      const now = nowIso();
      const rows = tickets.map((t) => ({ ...t, ...vendorLate(t, c, now) }));
      const raw = rows.reduce((s, t) => s + t.penalty, 0);
      return json({
        contract: { ...contractOut(c, today), penalties: capPenalty(raw, c), penalties_raw: raw },
        assets,
        visits,
        tickets: rows,
        history,
        today,
        can_manage: manager,
      });
    }
    if (method === 'GET' && seg[2] === 'pdf' && seg.length === 3) {
      const obj = c.pdf_key ? await env.FILES.get(c.pdf_key) : null;
      if (!obj) fail(404, 'not_found');
      return pdfResponse(obj, c.pdf_name);
    }
    if (method === 'PUT' && seg.length === 2) {
      needManager();
      const next = readContract(await readJson(request));
      if (next.vendor_id !== c.vendor_id && !(await env.DB.prepare('SELECT id FROM vendors WHERE id = ?').bind(next.vendor_id).first())) fail(400, 'vendor_required');
      // A new end date starts the reminders again.
      await env.DB.batch([
        env.DB.prepare(`UPDATE contracts SET ${CONTRACT_KEYS.map((k) => k + ' = ?').join(', ')}, alert_level = CASE WHEN end_date = ? THEN alert_level ELSE NULL END, updated_at = ? WHERE id = ?`).bind(
          ...CONTRACT_KEYS.map((k) => next[k]), next.end_date, nowIso(), id),
        logStmt(env, user, 'update', 'contract', id, label, changes(c, next, CONTRACT_KEYS)),
      ]);
      return json({ ok: true });
    }
    // A contract with requests, or one renewed by another, stays in the record.
    if (method === 'DELETE' && seg.length === 2) {
      needManager();
      const used = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM tickets WHERE contract_id = ?1) + (SELECT COUNT(*) FROM contracts WHERE prev_id = ?1) AS n').bind(id).first();
      if (used.n > 0) fail(409, 'contract_in_use');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM contract_assets WHERE contract_id = ?').bind(id),
        env.DB.prepare('DELETE FROM contract_visits WHERE contract_id = ?').bind(id),
        env.DB.prepare('DELETE FROM contracts WHERE id = ?').bind(id),
        logStmt(env, user, 'delete', 'contract', id, label),
      ]);
      if (c.pdf_key) await env.FILES.delete(c.pdf_key);
      return json({ ok: true });
    }
    // The signed contract as a PDF; a new one replaces the old.
    if (method === 'POST' && seg[2] === 'pdf' && seg.length === 3) {
      needManager();
      const form = await request.formData().catch(() => fail(400, 'bad_request'));
      const pdf = await readPdf(form);
      if (!pdf) fail(400, 'pdf_required');
      const key = `contract/${crypto.randomUUID()}.pdf`;
      await env.FILES.put(key, pdf.bytes, { httpMetadata: { contentType: 'application/pdf' } });
      try {
        await env.DB.batch([
          env.DB.prepare('UPDATE contracts SET pdf_key = ?, pdf_name = ?, pdf_size = ?, updated_at = ? WHERE id = ?').bind(key, pdf.name, pdf.size, nowIso(), id),
          logStmt(env, user, 'update', 'contract', id, label, { pdf_name: [c.pdf_name, pdf.name] }),
        ]);
      } catch (e) {
        await env.FILES.delete(key);
        throw e;
      }
      if (c.pdf_key) await env.FILES.delete(c.pdf_key);
      return json({ ok: true });
    }
    // The assets it covers, as the full list (one statement for the whole list).
    if (method === 'PUT' && seg[2] === 'assets' && seg.length === 3) {
      needManager();
      const body = await readJson(request);
      const ids = [...new Set((Array.isArray(body.asset_ids) ? body.asset_ids : []).map(toInt).filter((n) => n && n > 0))];
      if (ids.length > CONTRACT_ASSETS_MAX) fail(400, 'too_many_assets');
      const found = (await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).first()).n;
      if (found !== ids.length) fail(400, 'asset_required');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM contract_assets WHERE contract_id = ?').bind(id),
        env.DB.prepare('INSERT INTO contract_assets (contract_id, asset_id) SELECT ?1, value FROM json_each(?2)').bind(id, JSON.stringify(ids)),
        logStmt(env, user, 'update', 'contract', id, label, { asset_count: [c.asset_count, ids.length] }),
      ]);
      return json({ ok: true, count: ids.length });
    }
    if (method === 'POST' && seg[2] === 'visits' && seg.length === 3) {
      needManager();
      const body = await readJson(request);
      const done_on = optDate(body.done_on) || today;
      if (done_on > today) fail(400, 'invalid_date');
      if (done_on < c.start_date || done_on > c.end_date) fail(400, 'visit_outside');
      const ticketId = toInt(body.ticket_id);
      if (ticketId && !(await env.DB.prepare('SELECT id FROM tickets WHERE id = ?').bind(ticketId).first())) fail(400, 'ticket_required');
      const res = await env.DB.prepare('INSERT INTO contract_visits (contract_id, done_on, note, ticket_id, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, done_on, str(body.note, 500) || null, ticketId || null, user.name, nowIso())
        .run();
      await logStmt(env, user, 'create', 'contract_visit', res.meta.last_row_id, label, { done_on: [null, done_on] }).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    if (method === 'DELETE' && seg[2] === 'visits' && /^\d+$/.test(seg[3] || '') && seg.length === 4) {
      needManager();
      const visit = await env.DB.prepare('SELECT * FROM contract_visits WHERE id = ? AND contract_id = ?').bind(Number(seg[3]), id).first();
      if (!visit) fail(404, 'not_found');
      await env.DB.batch([env.DB.prepare('DELETE FROM contract_visits WHERE id = ?').bind(visit.id), logStmt(env, user, 'delete', 'contract_visit', visit.id, label, { done_on: [visit.done_on, null] })]);
      return json({ ok: true });
    }
    // Renewal: a new contract that carries this one on, with the same assets. The old one stays as it was.
    if (method === 'POST' && seg[2] === 'renew' && seg.length === 3) {
      needManager();
      if (c.renewed_by) fail(409, 'already_renewed');
      const next = readContract({ ...c, ...(await readJson(request)), vendor_id: c.vendor_id });
      if (next.start_date <= c.start_date) fail(400, 'renew_dates');
      const now = nowIso();
      const res = await env.DB.prepare(`INSERT INTO contracts (${CONTRACT_KEYS.join(', ')}, prev_id, created_at, updated_at) VALUES (${CONTRACT_KEYS.map(() => '?').join(', ')}, ?, ?, ?)`)
        .bind(...CONTRACT_KEYS.map((k) => next[k]), id, now, now)
        .run();
      const newId = res.meta.last_row_id;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO contract_assets (contract_id, asset_id) SELECT ?, asset_id FROM contract_assets WHERE contract_id = ?').bind(newId, id),
        logStmt(env, user, 'renew', 'contract', newId, `${next.title_ar} (${next.number})`, { end_date: [c.end_date, next.end_date], value: [c.value, next.value] }),
      ]);
      return json({ ok: true, id: newId });
    }
    fail(404, 'not_found');
  }

  return null;
}

// The contract that covers an asset today, if any (for its page and for a request about it).
export async function assetContract(env, assetId, today) {
  if (!assetId) return null;
  return env.DB.prepare(
    `SELECT c.id, c.number, c.title_ar, c.title_en, c.kind, c.end_date, c.response_hours, c.vendor_id, v.name_ar AS vendor_ar, v.name_en AS vendor_en, v.phone AS vendor_phone
       FROM contract_assets ca JOIN contracts c ON c.id = ca.contract_id JOIN vendors v ON v.id = c.vendor_id
      WHERE ca.asset_id = ?1 AND c.start_date <= ?2 AND c.end_date >= ?2 ORDER BY c.end_date DESC LIMIT 1`,
  ).bind(assetId, today).first();
}

// Each contract is reminded once at 90, 60 and 30 days; each paper once at 30 days and once when it expires.
// alert_level keeps the last step sent, so a missed day is caught up the next morning without sending twice.
export async function runContractReminders(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const [{ results: contracts }, { results: docs }] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.number, c.title_ar, c.title_en, c.end_date, c.alert_level, v.name_ar AS vendor_ar, v.name_en AS vendor_en FROM contracts c JOIN vendors v ON v.id = c.vendor_id
        WHERE c.end_date >= ?1 AND c.end_date <= ?2 AND NOT EXISTS (SELECT 1 FROM contracts n WHERE n.prev_id = c.id)`,
    ).bind(today, plusDays(today, CONTRACT_ALERTS[0])).all(),
    env.DB.prepare(
      `SELECT d.id, d.kind, d.number, d.expiry_date, d.alert_level, v.name_ar AS vendor_ar, v.name_en AS vendor_en FROM vendor_docs d JOIN vendors v ON v.id = d.vendor_id
        WHERE v.active = 1 AND d.expiry_date IS NOT NULL AND d.expiry_date <= ?`,
    ).bind(plusDays(today, DOC_ALERTS[0])).all(),
  ]);
  const step = (left, steps) => steps.filter((s) => left <= s).pop();
  const dueC = contracts.map((c) => ({ ...c, left: diffDays(c.end_date, today) })).map((c) => ({ ...c, step: step(c.left, CONTRACT_ALERTS) })).filter((c) => c.step !== undefined && (c.alert_level === null || c.alert_level > c.step));
  const dueD = docs.map((d) => ({ ...d, left: diffDays(d.expiry_date, today) })).map((d) => ({ ...d, step: step(d.left, DOC_ALERTS) })).filter((d) => d.step !== undefined && (d.alert_level === null || d.alert_level > d.step));
  if (!dueC.length && !dueD.length) return { contracts: 0, docs: 0, emails: 0 };
  if (!mailReady(settings)) return { contracts: dueC.length, docs: dueD.length, emails: 0, error: 'mail_not_configured' };
  // The asset managers, never the system admins (they asked not to get these emails).
  const { results: people } = await env.DB.prepare("SELECT email FROM users WHERE active = 1 AND role NOT IN ('super_admin', 'systems_admin') AND assets_role = 'manager'").all();
  const marks = [
    ...dueC.map((c) => env.DB.prepare('UPDATE contracts SET alert_level = ? WHERE id = ?').bind(c.step, c.id)),
    ...dueD.map((d) => env.DB.prepare('UPDATE vendor_docs SET alert_level = ? WHERE id = ?').bind(d.step, d.id)),
  ];
  if (!people.length) {
    await env.DB.batch(marks);
    return { contracts: dueC.length, docs: dueD.length, emails: 0 };
  }
  const link = `${settings.site_url || ''}/#/assets/contracts`;
  const mail = bothLangs(settings, (s) => {
    const L = CONTRACT_TEXT[s.email_lang];
    const ar = s.email_lang === 'ar';
    const li = (main, sub, d) => `<li style="margin:6px 0"><b>${escHtml(main)}</b> <span style="color:#6e6553">${escHtml(sub)}</span> <span style="color:${d <= 30 ? '#a8443a' : '#5f4a10'}">(${escHtml(L.days(d))})</span></li>`;
    const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${ar ? 'right' : 'left'}">${emailHeader(s)}<h2 style="font-size:17px">${escHtml(L.title)}</h2>
      ${dueC.length ? `<h3 style="font-size:15px;margin:14px 0 4px">${escHtml(L.ending)}</h3><ul style="padding-${ar ? 'right' : 'left'}:18px;margin:0">${dueC.map((c) => li(ar ? c.title_ar : c.title_en, `${c.number} - ${ar ? c.vendor_ar : c.vendor_en}`, c.left)).join('')}</ul>` : ''}
      ${dueD.length ? `<h3 style="font-size:15px;margin:14px 0 4px">${escHtml(L.docs)}</h3><ul style="padding-${ar ? 'right' : 'left'}:18px;margin:0">${dueD.map((d) => li(L.kind[d.kind], `${ar ? d.vendor_ar : d.vendor_en}${d.number ? ' - ' + d.number : ''}`, d.left)).join('')}</ul>` : ''}
      <p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
      <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(appName(s, s.email_lang)))}</p></div>`;
    return { subject: L.subject(dueC.length + dueD.length, appName(s, s.email_lang)), html };
  });
  const result = await sendMail(settings, people.map((p) => ({ to: p.email, ...mail })));
  // Marked as sent only when the mail went out, so a failure is tried again tomorrow.
  await env.DB.batch([
    ...(result.ok ? marks : []),
    logStmt(env, null, result.ok ? 'remind' : 'remind_failed', 'contract', null, null, result.ok ? { items: dueC.length + dueD.length, emails: people.length } : { error: result.error }),
  ]);
  return { contracts: dueC.length, docs: dueD.length, emails: result.ok ? people.length : 0 };
}

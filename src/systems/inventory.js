// Spare parts: stores, stock, receipts, part requests, costs and the low-stock reminders.
import { readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { changes, getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { checkLang, diffDays, escHtml, fail, isDate, json, nowIso, str, todayIn } from '../lib/util.js';
import { route2 } from './assets.js';
import { assetContract, num } from './contracts.js';
import { plusDays } from './docs.js';
import { TICKET_SELECT, canSeeTicket, canWorkTicket, eventStmt, toInt } from './tickets.js';

// Only the system owner (first account) picks how stock is managed.
const isOwner = async (env, user) => user.id === (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;

/* ------------------------------ spare parts ------------------------------ */

// Three ways of working, chosen once by the system admin:
//   standalone - the stock is kept here: bought, received, used and counted here.
//   linked     - the hospital's ERP keeps the main warehouse; the maintenance store here is fed by
//                transfers from it (and direct purchases). Receipts come in through the API; entering
//                them by hand is the fallback. Orders and invoices stay in the ERP: only their numbers come here.
//   erp        - the ERP keeps all stock. Parts are asked for here, the ERP hands them out, and
//                their use (with its cost) is recorded on the request.
// In every mode: no accounting entries here. The cost of each part used is charged to the department
// that owns the device (its cost center), and the ERP takes those figures from the API.
export const INV_MODES = ['standalone', 'linked', 'erp'];
export const PART_UNITS = ['piece', 'box', 'set', 'pack', 'roll', 'meter', 'liter', 'kg'];
export const RECEIPT_KINDS = { standalone: ['purchase', 'opening'], linked: ['transfer_in', 'purchase', 'opening'], erp: [] };
export const REQUEST_STATUSES = ['open', 'sent', 'done', 'cancelled'];
// Contracts under which the supplier pays for the parts: their cost is charged to the supplier, not the department.
export const COVER_KINDS = ['comprehensive', 'parts', 'warranty'];
export const RECEIPT_LINES_MAX = 100;
export const PART_ROWS_MAX = 2000;
export const CODE_RE = /^[\w./-]{1,40}$/; // part codes and ERP codes
export const DOC_RE = /^[\w./# -]{1,50}$/; // voucher, order and invoice numbers
export const PART_KEYS = ['code', 'name_ar', 'name_en', 'unit', 'type_id', 'min_qty', 'reorder_qty', 'erp_code', 'notes', 'active'];
export const STORE_KEYS = ['name_ar', 'name_en', 'erp_code', 'team_id', 'active'];
export const MOVE_COLS = ['kind', 'part_id', 'store_id', 'qty', 'unit_cost', 'ticket_id', 'asset_id', 'dept_id', 'covered', 'contract_id', 'vendor_id', 'doc_no', 'invoice_no', 'request_id', 'ref_id', 'batch', 'ext_id', 'source', 'note', 'user_name', 'created_at'];

export const invMode = (settings) => (INV_MODES.includes(settings.inventory_mode) ? settings.inventory_mode : 'standalone');
export const r3 = (n) => Math.round(n * 1000) / 1000;
export const qtyOf = (v) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n <= 0 || n > 1e6) fail(400, 'invalid_qty');
  return r3(n);
};
export const costOf = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e8) fail(400, 'invalid_number');
  return Math.round(n * 10000) / 10000;
};
export const codeOf = (v, re, err) => {
  const s = typeof v === 'number' ? String(v) : str(v, 60);
  if (!s) return null;
  if (!re.test(s)) fail(400, err);
  return s;
};
// The day an ISO time falls on in the hospital's time zone, for reports by date.
export function localDay(iso, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function readPart(body) {
  checkLang((k) => body[k], ['name_ar'], ['name_en', 'code', 'erp_code']);
  const next = {
    code: codeOf(body.code, CODE_RE, 'invalid_code'),
    name_ar: str(body.name_ar, 150),
    name_en: str(body.name_en, 150),
    unit: PART_UNITS.includes(body.unit) ? body.unit : 'piece',
    type_id: toInt(body.type_id) || null,
    min_qty: body.min_qty === undefined || body.min_qty === '' || body.min_qty === null ? 0 : r3(num(body.min_qty, 1e6)),
    reorder_qty: body.reorder_qty === undefined || body.reorder_qty === '' || body.reorder_qty === null ? 0 : r3(num(body.reorder_qty, 1e6)),
    erp_code: codeOf(body.erp_code, CODE_RE, 'invalid_code'),
    notes: str(body.notes, 1000) || null,
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
  if (!next.code) fail(400, 'code_required');
  if (!next.name_ar || !next.name_en) fail(400, 'name_required');
  return next;
}

export const moveStmt = (env, m) =>
  env.DB.prepare(`INSERT INTO stock_moves (${MOVE_COLS.join(', ')}) VALUES (${MOVE_COLS.map(() => '?').join(', ')})`).bind(
    ...MOVE_COLS.map((k) => (m[k] !== undefined && m[k] !== null ? m[k] : k === 'covered' ? 0 : k === 'source' ? 'ui' : null)),
  );

// A store fell to a part's minimum: one request is opened for it, unless one is already open or sent.
export const lowStockStmt = (env, now, partId) =>
  env.DB.prepare(
    `INSERT INTO part_requests (part_id, store_id, qty, reason, status, user_name, created_at, updated_at)
     SELECT s.part_id, s.store_id, CASE WHEN p.reorder_qty > 0 THEN p.reorder_qty ELSE MAX(ROUND(p.min_qty * 2 - s.qty, 3), 1) END, 'low_stock', 'open', 'system', ?1, ?1
       FROM stock s JOIN parts p ON p.id = s.part_id JOIN stores st ON st.id = s.store_id
      WHERE p.active = 1 AND st.active = 1 AND p.min_qty > 0 AND s.qty <= p.min_qty ${partId ? 'AND s.part_id = ?2' : ''}
        AND NOT EXISTS (SELECT 1 FROM part_requests r WHERE r.part_id = s.part_id AND r.store_id = s.store_id AND r.status IN ('open', 'sent'))`,
  ).bind(now, ...(partId ? [partId] : []));
// Back above the minimum: the next fall is emailed again.
export const realertStmt = (env) => env.DB.prepare('UPDATE stock SET alerted = 0 WHERE alerted = 1 AND qty > (SELECT p.min_qty FROM parts p WHERE p.id = stock.part_id)');

export const isConstraint = (e) => /constraint/i.test(String(e && e.message));

// Who pays for a part used on a request: the department owning the device (or the requester's), or the
// supplier when a running contract on the device includes parts.
export async function partCharge(env, t, today) {
  const [asset, c] = await Promise.all([t.asset_id ? env.DB.prepare('SELECT department_id FROM assets WHERE id = ?').bind(t.asset_id).first() : null, assetContract(env, t.asset_id, today)]);
  const covered = !!c && COVER_KINDS.includes(c.kind);
  return {
    ticket_id: t.id,
    asset_id: t.asset_id || null,
    dept_id: (asset && asset.department_id) || t.requester_dept_id || null,
    covered: covered ? 1 : 0,
    contract_id: covered ? c.id : null,
    vendor_id: covered ? c.vendor_id : null,
  };
}

// A receipt: one statement for each step whatever the number of lines. Each line is { p: part, q: qty, c: unit cost }.
// The average cost is worked out before the stock goes up: (old qty x old cost + new qty x new cost) / total qty.
export function receiptStmts(env, r) {
  const lines = JSON.stringify(r.lines);
  const stmts = [
    env.DB.prepare(
      `UPDATE parts SET unit_cost = ROUND((parts.unit_cost * COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.part_id = parts.id), 0) + l.v)
                                          / (COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.part_id = parts.id), 0) + l.q), 4), updated_at = ?2
         FROM (SELECT json_extract(value, '$.p') AS p, json_extract(value, '$.q') AS q, json_extract(value, '$.q') * json_extract(value, '$.c') AS v FROM json_each(?1)) AS l
        WHERE parts.id = l.p`,
    ).bind(lines, r.now),
    env.DB.prepare(
      `INSERT INTO stock (part_id, store_id, qty) SELECT json_extract(value, '$.p'), ?2, json_extract(value, '$.q') FROM json_each(?1) WHERE 1
       ON CONFLICT (part_id, store_id) DO UPDATE SET qty = ROUND(stock.qty + excluded.qty, 3)`,
    ).bind(lines, r.store_id),
    env.DB.prepare(
      `INSERT INTO stock_moves (kind, part_id, store_id, qty, unit_cost, vendor_id, doc_no, invoice_no, request_id, batch, ext_id, source, note, user_name, created_at)
       SELECT ?2, json_extract(value, '$.p'), ?3, json_extract(value, '$.q'), json_extract(value, '$.c'), ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13 FROM json_each(?1)`,
    ).bind(lines, r.kind, r.store_id, r.vendor_id || null, r.doc_no || null, r.invoice_no || null, r.request_ids.length === 1 ? r.request_ids[0] : null, r.batch, r.ext_id || null, r.source, r.note || null, r.user_name, r.now),
    realertStmt(env),
  ];
  if (r.request_ids.length)
    stmts.push(
      env.DB.prepare("UPDATE part_requests SET status = 'done', done_at = ?2, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?1)) AND status IN ('open', 'sent')").bind(JSON.stringify(r.request_ids), r.now),
    );
  return stmts;
}

// Lines as sent ({ part_id, qty, unit_cost }), merged by part and checked against the parts list.
// A line without a cost is taken at the part's current average cost.
export async function receiptLines(env, raw, byCode) {
  if (!Array.isArray(raw) || !raw.length) fail(400, 'lines_required');
  if (raw.length > RECEIPT_LINES_MAX) fail(400, 'too_many_lines');
  const merged = new Map();
  for (const l of raw) {
    if (!l || typeof l !== 'object') fail(400, 'bad_request');
    const key = byCode ? codeOf(l.code, CODE_RE, 'invalid_code') : toInt(l.part_id);
    if (!key) fail(400, 'part_required');
    const q = qtyOf(l.qty);
    const c = costOf(l.unit_cost);
    const m = merged.get(key) || { q: 0, v: 0, nocost: 0 };
    m.q = r3(m.q + q);
    if (c === null) m.nocost = r3(m.nocost + q);
    else m.v += q * c;
    merged.set(key, m);
  }
  const keys = [...merged.keys()];
  const { results: parts } = await env.DB.prepare(`SELECT id, code, unit_cost, name_ar FROM parts WHERE active = 1 AND ${byCode ? 'code' : 'id'} IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
  const found = new Map(parts.map((p) => [byCode ? p.code : p.id, p]));
  const missing = keys.filter((k) => !found.has(k));
  if (missing.length) return { missing };
  return {
    lines: keys.map((k) => {
      const m = merged.get(k);
      const p = found.get(k);
      return { p: p.id, q: m.q, c: Math.round(((m.v + m.nocost * p.unit_cost) / m.q) * 10000) / 10000 };
    }),
  };
}

// A part the ERP handed out for a request (erp mode): its use and cost go on the request, no stock moves here.
export async function erpIssueStmts(env, req, t, qty, unitCost, extId, source, userName, today) {
  const now = nowIso();
  const charge = await partCharge(env, t, today);
  return [
    moveStmt(env, { kind: 'issue', part_id: req.part_id, qty: -qty, unit_cost: unitCost, ...charge, request_id: req.id, ext_id: extId, source, user_name: userName, created_at: now }),
    env.DB.prepare("UPDATE part_requests SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?").bind(now, now, req.id),
    env.DB.prepare('UPDATE parts SET unit_cost = ?, updated_at = ? WHERE id = ?').bind(unitCost, now, req.part_id),
    eventStmt(env, t.id, { id: null, name: userName }, 'part_issued', null, { code: req.code, part: req.name_ar, part_en: req.name_en, qty, unit: req.unit }),
  ];
}

export const REQUEST_SELECT = `SELECT r.*, p.code, p.erp_code, p.name_ar, p.name_en, p.unit, st.name_ar AS store_ar, st.name_en AS store_en, st.erp_code AS store_code,
       t.status AS ticket_status, a.tag AS asset_tag
  FROM part_requests r JOIN parts p ON p.id = r.part_id LEFT JOIN stores st ON st.id = r.store_id
  LEFT JOIN tickets t ON t.id = r.ticket_id LEFT JOIN assets a ON a.id = t.asset_id`;

// Parts used on requests between two days (in the hospital's time zone), with their cost and who it is charged to.
export async function costReport(env, settings, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.kind, m.qty, m.unit_cost, m.covered, m.ticket_id, m.created_at, m.dept_id, m.asset_id, m.vendor_id,
            p.code, p.erp_code, p.name_ar, p.name_en, p.unit, d.name_ar AS dept_ar, d.name_en AS dept_en, d.cost_center,
            a.tag AS asset_tag, a.name_ar AS asset_ar, a.name_en AS asset_en, v.name_ar AS vendor_ar, v.name_en AS vendor_en
       FROM stock_moves m JOIN parts p ON p.id = m.part_id LEFT JOIN departments d ON d.id = m.dept_id
       LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN vendors v ON v.id = m.vendor_id
      WHERE m.kind IN ('issue', 'return') AND m.created_at >= ?1 AND m.created_at < ?2 ORDER BY m.id LIMIT 20001`,
  )
    .bind(plusDays(from, -1) + 'T00:00:00.000Z', plusDays(to, 2) + 'T00:00:00.000Z')
    .all();
  const lines = results
    .map((m) => ({ ...m, day: localDay(m.created_at, settings.timezone), qty: -m.qty, cost: Math.round(-m.qty * m.unit_cost * 100) / 100 }))
    .filter((m) => m.day >= from && m.day <= to);
  const group = (key, make) => {
    const out = new Map();
    for (const m of lines) {
      const k = key(m);
      const g = out.get(k) || { ...make(m), cost: 0, covered: 0, lines: 0 };
      if (m.covered) g.covered += m.cost;
      else g.cost += m.cost;
      g.lines++;
      out.set(k, g);
    }
    return [...out.values()].map((g) => ({ ...g, cost: Math.round(g.cost * 100) / 100, covered: Math.round(g.covered * 100) / 100 })).sort((a, b) => b.cost + b.covered - (a.cost + a.covered));
  };
  const sum = (f) => Math.round(lines.filter(f).reduce((s, m) => s + m.cost, 0) * 100) / 100;
  return {
    from,
    to,
    total: sum((m) => !m.covered),
    covered: sum((m) => m.covered),
    by_dept: group((m) => m.dept_id || 0, (m) => ({ dept_id: m.dept_id, dept_ar: m.dept_ar, dept_en: m.dept_en, cost_center: m.cost_center })),
    by_asset: group((m) => m.asset_id || 0, (m) => ({ asset_id: m.asset_id, tag: m.asset_tag, name_ar: m.asset_ar, name_en: m.asset_en })),
    lines,
    more: results.length > 20000,
  };
}
export const reportRange = (url, today) => {
  const from = url.searchParams.get('from') || today.slice(0, 8) + '01';
  const to = url.searchParams.get('to') || today;
  if (!isDate(from) || !isDate(to) || to < from || diffDays(to, from) > 366) fail(400, 'invalid_date');
  return [from, to];
};

export async function handleInventory(request, env, url, seg, method, user) {
  const settings = await getSettings(env);
  const mode = invMode(settings);
  const stocked = mode !== 'erp';
  const today = todayIn(settings.timezone);
  const role = user.assets;
  const manager = role === 'admin' || role === 'manager';
  const needManager = () => {
    if (!manager) fail(403, 'forbidden');
  };
  const needStock = () => {
    if (!stocked) fail(409, 'inventory_mode');
  };
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  const route = route2(method, seg);

  /* ---- on a request: the parts used, given back, and asked for ---- */

  if (seg[0] === 'tickets') {
    const t = await env.DB.prepare(TICKET_SELECT + ' WHERE t.id = ?').bind(id).first();
    if (!t || !(canSeeTicket(user, t) || manager)) fail(404, 'not_found');
    const work = canWorkTicket(user, t) || manager;
    const open = () => {
      if (!work) fail(403, 'forbidden');
      if (t.status === 'closed' && !manager) fail(409, 'ticket_changed');
    };
    if (method === 'GET' && seg[2] === 'parts' && seg.length === 3) {
      const [{ results: moves }, { results: requests }] = await Promise.all([
        env.DB.prepare(
          `SELECT m.id, m.kind, m.part_id, m.store_id, m.qty, m.unit_cost, m.covered, m.ref_id, m.user_name, m.created_at, m.source,
                  p.code, p.name_ar, p.name_en, p.unit, st.name_ar AS store_ar, st.name_en AS store_en,
                  (SELECT COALESCE(SUM(b.qty), 0) FROM stock_moves b WHERE b.ref_id = m.id AND b.kind = 'return') AS returned
             FROM stock_moves m JOIN parts p ON p.id = m.part_id LEFT JOIN stores st ON st.id = m.store_id
            WHERE m.ticket_id = ? AND m.kind IN ('issue', 'return') ORDER BY m.id`,
        ).bind(id).all(),
        env.DB.prepare(REQUEST_SELECT + ' WHERE r.ticket_id = ? ORDER BY r.id').bind(id).all(),
      ]);
      const cost = (covered) => Math.round(moves.filter((m) => !!m.covered === covered).reduce((s, m) => s - m.qty * m.unit_cost, 0) * 100) / 100;
      return json({ mode, moves, requests, cost: cost(false), covered: cost(true), can_issue: work && (t.status !== 'closed' || manager) });
    }
    if (method === 'POST' && seg[2] === 'parts' && seg.length === 3) {
      open();
      needStock();
      const body = await readJson(request);
      const qty = qtyOf(body.qty);
      const [part, row] = await Promise.all([
        env.DB.prepare('SELECT * FROM parts WHERE id = ? AND active = 1').bind(toInt(body.part_id) ?? 0).first(),
        env.DB.prepare('SELECT s.qty FROM stock s JOIN stores st ON st.id = s.store_id WHERE s.part_id = ? AND s.store_id = ? AND st.active = 1').bind(toInt(body.part_id) ?? 0, toInt(body.store_id) ?? 0).first(),
      ]);
      if (!part) fail(400, 'part_required');
      if (!row || row.qty < qty) fail(409, 'not_enough_stock');
      const now = nowIso();
      const charge = await partCharge(env, t, today);
      try {
        await env.DB.batch([
          // The CHECK on stock refuses a quantity below zero, so two people taking the last one cannot both succeed.
          env.DB.prepare('UPDATE stock SET qty = ROUND(qty - ?, 3) WHERE part_id = ? AND store_id = ?').bind(qty, part.id, toInt(body.store_id)),
          moveStmt(env, { kind: 'issue', part_id: part.id, store_id: toInt(body.store_id), qty: -qty, unit_cost: part.unit_cost, ...charge, note: str(body.note, 300) || null, user_name: user.name, created_at: now }),
          eventStmt(env, id, user, 'part_issued', str(body.note, 300) || null, { code: part.code, part: part.name_ar, part_en: part.name_en, qty, unit: part.unit }),
          lowStockStmt(env, now, part.id),
        ]);
      } catch (e) {
        if (isConstraint(e)) fail(409, 'not_enough_stock');
        throw e;
      }
      return json({ ok: true });
    }
    if (method === 'POST' && seg[2] === 'parts' && /^\d+$/.test(seg[3] || '') && seg[4] === 'return' && seg.length === 5) {
      open();
      const body = await readJson(request);
      const qty = qtyOf(body.qty);
      const issue = await env.DB.prepare(
        `SELECT m.*, p.code, p.name_ar, p.name_en, p.unit, (SELECT COALESCE(SUM(b.qty), 0) FROM stock_moves b WHERE b.ref_id = m.id AND b.kind = 'return') AS returned
           FROM stock_moves m JOIN parts p ON p.id = m.part_id WHERE m.id = ? AND m.ticket_id = ? AND m.kind = 'issue'`,
      ).bind(Number(seg[3]), id).first();
      if (!issue) fail(404, 'not_found');
      if (qty > r3(-issue.qty - issue.returned)) fail(400, 'return_too_much');
      const now = nowIso();
      const stmts = [];
      // A part handed out by the ERP goes back to the ERP: only the request's cost changes here.
      if (issue.store_id) {
        stmts.push(env.DB.prepare('INSERT INTO stock (part_id, store_id, qty) VALUES (?, ?, ?) ON CONFLICT (part_id, store_id) DO UPDATE SET qty = ROUND(stock.qty + excluded.qty, 3)').bind(issue.part_id, issue.store_id, qty));
      }
      stmts.push(
        moveStmt(env, {
          ...Object.fromEntries(['part_id', 'store_id', 'unit_cost', 'ticket_id', 'asset_id', 'dept_id', 'covered', 'contract_id', 'vendor_id'].map((k) => [k, issue[k]])),
          kind: 'return', qty, ref_id: issue.id, note: str(body.note, 300) || null, user_name: user.name, created_at: now,
        }),
        eventStmt(env, id, user, 'part_returned', str(body.note, 300) || null, { code: issue.code, part: issue.name_ar, part_en: issue.name_en, qty, unit: issue.unit }),
        realertStmt(env),
      );
      try {
        await env.DB.batch(stmts);
      } catch (e) {
        if (isConstraint(e)) fail(409, 'ticket_changed');
        throw e;
      }
      return json({ ok: true });
    }
    if (method === 'POST' && seg[2] === 'part-requests' && seg.length === 3) {
      open();
      const body = await readJson(request);
      const qty = qtyOf(body.qty);
      const part = await env.DB.prepare('SELECT * FROM parts WHERE id = ? AND active = 1').bind(toInt(body.part_id) ?? 0).first();
      if (!part) fail(400, 'part_required');
      const storeId = toInt(body.store_id);
      if (storeId && !(await env.DB.prepare('SELECT id FROM stores WHERE id = ? AND active = 1').bind(storeId).first())) fail(400, 'store_required');
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM part_requests WHERE ticket_id = ? AND status IN ('open', 'sent')").bind(id).first();
      if (pending.n >= 20) fail(409, 'too_many_part_requests');
      const now = nowIso();
      const note = str(body.note, 300) || null;
      const res = await env.DB.prepare("INSERT INTO part_requests (part_id, store_id, qty, reason, ticket_id, status, note, user_name, created_at, updated_at) VALUES (?, ?, ?, 'ticket', ?, 'open', ?, ?, ?, ?)")
        .bind(part.id, stocked ? storeId : null, qty, id, note, user.name, now, now)
        .run();
      await eventStmt(env, id, user, 'part_requested', note, { code: part.code, part: part.name_ar, part_en: part.name_en, qty, unit: part.unit }).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    fail(404, 'not_found');
  }

  // The parts a technician can use on a request: with the stock in each store (all active parts in erp mode).
  if (route === 'GET /inventory/pick') {
    if (role === 'none' && !['technician', 'supervisor', 'admin'].includes(user.desk)) fail(403, 'forbidden');
    const [{ results: parts }, { results: stock }, { results: stores }] = await Promise.all([
      env.DB.prepare('SELECT id, code, name_ar, name_en, unit, type_id FROM parts WHERE active = 1 ORDER BY code').all(),
      stocked ? env.DB.prepare('SELECT s.part_id, s.store_id, s.qty FROM stock s JOIN stores st ON st.id = s.store_id WHERE st.active = 1 AND s.qty > 0').all() : { results: [] },
      env.DB.prepare('SELECT id, name_ar, name_en FROM stores WHERE active = 1 ORDER BY id').all(),
    ]);
    return json({ mode, parts: parts.map((p) => ({ ...p, stock: stock.filter((s) => s.part_id === p.id).map(({ store_id, qty }) => ({ store_id, qty })) })), stores });
  }

  if (role === 'none') fail(403, 'forbidden');

  /* ---- the stock: parts, stores, mode ---- */

  if (route === 'GET /inventory') {
    const [{ results: parts }, { results: stock }, { results: stores }, { results: types }, { results: vendors }, { results: teams }, reqs] = await Promise.all([
      env.DB.prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM part_requests r WHERE r.part_id = p.id AND r.status IN ('open', 'sent')) AS open_requests,
                (SELECT COUNT(*) FROM stock_moves m WHERE m.part_id = p.id) AS move_count
           FROM parts p ORDER BY p.code`,
      ).all(),
      env.DB.prepare('SELECT part_id, store_id, qty FROM stock').all(),
      env.DB.prepare('SELECT st.*, (SELECT COUNT(*) FROM stock_moves m WHERE m.store_id = st.id) AS move_count FROM stores st ORDER BY st.id').all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM asset_types WHERE active = 1 ORDER BY name_ar').all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM vendors WHERE active = 1 ORDER BY name_ar').all(),
      env.DB.prepare('SELECT id, name_ar, name_en FROM departments WHERE is_team = 1 ORDER BY id').all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM part_requests WHERE status IN ('open', 'sent')").first(),
    ]);
    const active = new Set(stores.filter((s) => s.active).map((s) => s.id));
    const out = parts.map((p) => {
      const rows = stock.filter((s) => s.part_id === p.id);
      const qty = r3(rows.reduce((s, r) => s + r.qty, 0));
      return {
        ...p,
        stock: rows.map(({ store_id, qty: q }) => ({ store_id, qty: q })),
        qty,
        value: Math.round(qty * p.unit_cost * 100) / 100,
        low: stocked && p.active && p.min_qty > 0 && rows.some((r) => active.has(r.store_id) && r.qty <= p.min_qty),
      };
    });
    return json({
      mode,
      parts: out,
      stores,
      types,
      vendors,
      teams,
      units: PART_UNITS,
      receipt_kinds: RECEIPT_KINDS[mode],
      open_requests: reqs.n,
      value: Math.round(out.reduce((s, p) => s + p.value, 0) * 100) / 100,
      can_manage: manager,
      can_mode: await isOwner(env, user),
    });
  }
  // Switching mode keeps every record; only what can be done next changes.
  if (route === 'PUT /inventory/mode') {
    if (!(await isOwner(env, user))) fail(403, 'owner_only');
    const body = await readJson(request);
    if (!INV_MODES.includes(body.mode)) fail(400, 'bad_request');
    if (body.mode !== mode) await env.DB.batch([setSettingStmt(env, 'inventory_mode', body.mode), logStmt(env, user, 'update', 'settings', null, null, { inventory_mode: [mode, body.mode] })]);
    return json({ ok: true, mode: body.mode });
  }

  if (route === 'POST /parts') {
    needManager();
    const next = readPart(await readJson(request));
    if (next.type_id && !(await env.DB.prepare('SELECT id FROM asset_types WHERE id = ?').bind(next.type_id).first())) fail(400, 'type_required');
    const now = nowIso();
    let res;
    try {
      res = await env.DB.prepare(`INSERT INTO parts (${PART_KEYS.join(', ')}, created_at, updated_at) VALUES (${PART_KEYS.map(() => '?').join(', ')}, ?, ?)`).bind(...PART_KEYS.map((k) => next[k]), now, now).run();
    } catch (e) {
      if (isConstraint(e)) fail(409, 'code_taken');
      throw e;
    }
    await logStmt(env, user, 'create', 'part', res.meta.last_row_id, `${next.name_ar} (${next.code})`).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if (seg[0] === 'parts' && id !== null) {
    const part = await env.DB.prepare('SELECT * FROM parts WHERE id = ?').bind(id).first();
    if (!part) fail(404, 'not_found');
    const label = `${part.name_ar} (${part.code})`;
    if (method === 'GET' && seg.length === 2) {
      const [{ results: stock }, { results: moves }, { results: requests }] = await Promise.all([
        env.DB.prepare('SELECT s.store_id, s.qty, st.name_ar, st.name_en, st.active FROM stock s JOIN stores st ON st.id = s.store_id WHERE s.part_id = ? ORDER BY st.id').bind(id).all(),
        env.DB.prepare(
          `SELECT m.*, st.name_ar AS store_ar, st.name_en AS store_en, a.tag AS asset_tag, d.name_ar AS dept_ar, d.name_en AS dept_en
             FROM stock_moves m LEFT JOIN stores st ON st.id = m.store_id LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN departments d ON d.id = m.dept_id
            WHERE m.part_id = ? ORDER BY m.id DESC LIMIT 300`,
        ).bind(id).all(),
        env.DB.prepare(REQUEST_SELECT + ' WHERE r.part_id = ? ORDER BY r.id DESC LIMIT 100').bind(id).all(),
      ]);
      return json({ mode, part, stock, moves, requests, can_manage: manager });
    }
    if (method === 'PUT' && seg.length === 2) {
      needManager();
      const next = readPart(await readJson(request));
      if (next.type_id && next.type_id !== part.type_id && !(await env.DB.prepare('SELECT id FROM asset_types WHERE id = ?').bind(next.type_id).first())) fail(400, 'type_required');
      try {
        await env.DB.batch([
          env.DB.prepare(`UPDATE parts SET ${PART_KEYS.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...PART_KEYS.map((k) => next[k]), nowIso(), id),
          logStmt(env, user, 'update', 'part', id, `${next.name_ar} (${next.code})`, changes(part, next, PART_KEYS)),
          realertStmt(env),
          ...(stocked ? [lowStockStmt(env, nowIso(), id)] : []),
        ]);
      } catch (e) {
        if (isConstraint(e)) fail(409, 'code_taken');
        throw e;
      }
      return json({ ok: true });
    }
    // A part with a history stays in the record: it can be switched off instead.
    if (method === 'DELETE' && seg.length === 2) {
      needManager();
      const used = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM stock_moves WHERE part_id = ?1) + (SELECT COUNT(*) FROM part_requests WHERE part_id = ?1) AS n').bind(id).first();
      if (used.n > 0) fail(409, 'part_in_use');
      await env.DB.batch([env.DB.prepare('DELETE FROM stock WHERE part_id = ?').bind(id), env.DB.prepare('DELETE FROM parts WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'part', id, label)]);
      return json({ ok: true });
    }
    fail(404, 'not_found');
  }

  const readStore = async () => {
    const body = await readJson(request);
    checkLang((k) => body[k], ['name_ar'], ['name_en', 'erp_code']);
    const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100), erp_code: codeOf(body.erp_code, CODE_RE, 'invalid_code'), team_id: toInt(body.team_id) || null, active: body.active === false ? 0 : 1 };
    if (!next.name_ar || !next.name_en) fail(400, 'name_required');
    if (next.team_id && !(await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND is_team = 1').bind(next.team_id).first())) fail(400, 'team_required');
    return next;
  };
  if (route === 'POST /stores') {
    needManager();
    const next = await readStore();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM stores').first();
    if (count.n >= 50) fail(409, 'too_many_stores');
    const now = nowIso();
    const res = await env.DB.prepare(`INSERT INTO stores (${STORE_KEYS.join(', ')}, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(...STORE_KEYS.map((k) => next[k]), now, now).run();
    await logStmt(env, user, 'create', 'store', res.meta.last_row_id, next.name_ar).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if (seg[0] === 'stores' && id !== null && seg.length === 2) {
    needManager();
    const store = await env.DB.prepare('SELECT * FROM stores WHERE id = ?').bind(id).first();
    if (!store) fail(404, 'not_found');
    if (method === 'PUT') {
      const next = await readStore();
      await env.DB.batch([
        env.DB.prepare(`UPDATE stores SET ${STORE_KEYS.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...STORE_KEYS.map((k) => next[k]), nowIso(), id),
        logStmt(env, user, 'update', 'store', id, next.name_ar, changes(store, next, STORE_KEYS)),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const used = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM stock_moves WHERE store_id = ?1) + (SELECT COUNT(*) FROM part_requests WHERE store_id = ?1) AS n').bind(id).first();
      if (used.n > 0) fail(409, 'store_in_use');
      await env.DB.batch([env.DB.prepare('DELETE FROM stock WHERE store_id = ?').bind(id), env.DB.prepare('DELETE FROM stores WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'store', id, store.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* ---- stock moves: receipts, counts, the record ---- */

  if (route === 'POST /stock-moves/receive') {
    needManager();
    needStock();
    const body = await readJson(request);
    checkLang((k) => body[k], [], ['doc_no', 'invoice_no']);
    const kind = RECEIPT_KINDS[mode].includes(body.kind) ? body.kind : null;
    if (!kind) fail(400, 'invalid_kind');
    const store = await env.DB.prepare('SELECT id, name_ar FROM stores WHERE id = ? AND active = 1').bind(toInt(body.store_id) ?? 0).first();
    if (!store) fail(400, 'store_required');
    const doc_no = codeOf(body.doc_no, DOC_RE, 'invalid_doc_no');
    const invoice_no = codeOf(body.invoice_no, DOC_RE, 'invalid_doc_no');
    // A transfer names the main warehouse's voucher; a purchase its order or invoice.
    if (kind === 'transfer_in' && !doc_no) fail(400, 'doc_required');
    if (kind === 'purchase' && !doc_no && !invoice_no) fail(400, 'doc_required');
    const vendorId = kind === 'purchase' ? toInt(body.vendor_id) : null;
    if (vendorId && !(await env.DB.prepare('SELECT id FROM vendors WHERE id = ?').bind(vendorId).first())) fail(400, 'vendor_required');
    const requestIds = [...new Set((Array.isArray(body.request_ids) ? body.request_ids : []).map(toInt).filter((n) => n > 0))].slice(0, 50);
    const got = await receiptLines(env, body.lines, false);
    if (got.missing) fail(400, 'part_required');
    const now = nowIso();
    const batch = crypto.randomUUID();
    await env.DB.batch([
      ...receiptStmts(env, { kind, store_id: store.id, lines: got.lines, doc_no, invoice_no, vendor_id: vendorId, request_ids: requestIds, batch, source: 'ui', note: str(body.note, 300), user_name: user.name, now }),
      logStmt(env, user, 'receive', 'stock', store.id, store.name_ar, { kind: [null, kind], lines: [null, got.lines.length], doc_no: [null, doc_no || invoice_no] }),
    ]);
    return json({ ok: true, lines: got.lines.length });
  }
  // A stock count: the quantity found on the shelf replaces the one on record; the difference is kept as a move.
  if (route === 'POST /stock-moves/count') {
    needManager();
    needStock();
    const body = await readJson(request);
    const store = await env.DB.prepare('SELECT id, name_ar FROM stores WHERE id = ?').bind(toInt(body.store_id) ?? 0).first();
    if (!store) fail(400, 'store_required');
    if (!Array.isArray(body.lines) || !body.lines.length) fail(400, 'lines_required');
    if (body.lines.length > 500) fail(400, 'too_many_lines');
    const seen = new Map();
    for (const l of body.lines) {
      const p = l && toInt(l.part_id);
      const c = l && l.counted !== '' && l.counted !== null && l.counted !== undefined ? Number(l.counted) : NaN;
      if (!p || !Number.isFinite(c) || c < 0 || c > 1e7) fail(400, 'invalid_qty');
      seen.set(p, r3(c));
    }
    const lines = JSON.stringify([...seen].map(([p, c]) => ({ p, c })));
    const found = (await env.DB.prepare('SELECT COUNT(*) AS n FROM parts WHERE id IN (SELECT json_extract(value, \'$.p\') FROM json_each(?))').bind(lines).first()).n;
    if (found !== seen.size) fail(400, 'part_required');
    const now = nowIso();
    const res = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stock_moves (kind, part_id, store_id, qty, unit_cost, batch, source, note, user_name, created_at)
         SELECT 'adjust', l.p, ?2, ROUND(l.c - COALESCE(s.qty, 0), 3), pr.unit_cost, ?3, 'ui', ?4, ?5, ?6
           FROM (SELECT json_extract(value, '$.p') AS p, json_extract(value, '$.c') AS c FROM json_each(?1)) AS l
           JOIN parts pr ON pr.id = l.p LEFT JOIN stock s ON s.part_id = l.p AND s.store_id = ?2
          WHERE ROUND(l.c - COALESCE(s.qty, 0), 3) <> 0`,
      ).bind(lines, store.id, crypto.randomUUID(), str(body.note, 300) || null, user.name, now),
      env.DB.prepare(
        `INSERT INTO stock (part_id, store_id, qty) SELECT json_extract(value, '$.p'), ?2, json_extract(value, '$.c') FROM json_each(?1) WHERE 1
         ON CONFLICT (part_id, store_id) DO UPDATE SET qty = excluded.qty`,
      ).bind(lines, store.id),
      realertStmt(env),
      lowStockStmt(env, now),
    ]);
    const diffs = res[0].meta.changes || 0;
    await logStmt(env, user, 'count', 'stock', store.id, store.name_ar, { lines: [null, seen.size], differences: [null, diffs] }).run();
    return json({ ok: true, counted: seen.size, differences: diffs });
  }
  if (route === 'GET /stock-moves') {
    const days = [30, 90, 365].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
    const { results } = await env.DB.prepare(
      `SELECT m.*, p.code, p.name_ar, p.name_en, p.unit, st.name_ar AS store_ar, st.name_en AS store_en, a.tag AS asset_tag,
              d.name_ar AS dept_ar, d.name_en AS dept_en, v.name_ar AS vendor_ar, v.name_en AS vendor_en
         FROM stock_moves m JOIN parts p ON p.id = m.part_id LEFT JOIN stores st ON st.id = m.store_id LEFT JOIN assets a ON a.id = m.asset_id
         LEFT JOIN departments d ON d.id = m.dept_id LEFT JOIN vendors v ON v.id = m.vendor_id
        WHERE m.created_at >= ? ORDER BY m.id DESC LIMIT 3000`,
    ).bind(new Date(Date.now() - days * 86400000).toISOString()).all();
    return json({ mode, moves: results, days });
  }

  /* ---- part requests ---- */

  if (route === 'GET /part-requests') {
    const all = url.searchParams.get('status') === 'all';
    const { results } = await env.DB.prepare(REQUEST_SELECT + (all ? '' : " WHERE r.status IN ('open', 'sent')") + ' ORDER BY r.id DESC LIMIT 1000').all();
    return json({ mode, requests: results, can_manage: manager });
  }
  if (route === 'POST /part-requests') {
    needManager();
    const body = await readJson(request);
    const qty = qtyOf(body.qty);
    const part = await env.DB.prepare('SELECT id, name_ar, code FROM parts WHERE id = ? AND active = 1').bind(toInt(body.part_id) ?? 0).first();
    if (!part) fail(400, 'part_required');
    const storeId = stocked ? toInt(body.store_id) : null;
    if (storeId && !(await env.DB.prepare('SELECT id FROM stores WHERE id = ? AND active = 1').bind(storeId).first())) fail(400, 'store_required');
    const now = nowIso();
    const res = await env.DB.prepare("INSERT INTO part_requests (part_id, store_id, qty, reason, status, note, user_name, created_at, updated_at) VALUES (?, ?, ?, 'manual', 'open', ?, ?, ?, ?)")
      .bind(part.id, storeId, qty, str(body.note, 300) || null, user.name, now, now)
      .run();
    await logStmt(env, user, 'create', 'part_request', res.meta.last_row_id, `${part.name_ar} (${part.code})`, { qty: [null, qty] }).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  if (seg[0] === 'part-requests' && id !== null) {
    needManager();
    const req = await env.DB.prepare(REQUEST_SELECT + ' WHERE r.id = ?').bind(id).first();
    if (!req) fail(404, 'not_found');
    const label = `${req.name_ar} (${req.code})`;
    if (req.status === 'done' || req.status === 'cancelled') fail(409, 'request_closed');
    if (method === 'PUT' && seg.length === 2) {
      const body = await readJson(request);
      checkLang((k) => body[k], [], ['ext_ref']);
      const status = REQUEST_STATUSES.includes(body.status) ? body.status : null;
      if (!status) fail(400, 'bad_request');
      const extRef = body.ext_ref === undefined ? req.ext_ref : codeOf(body.ext_ref, DOC_RE, 'invalid_doc_no');
      const now = nowIso();
      await env.DB.batch([
        env.DB.prepare("UPDATE part_requests SET status = ?, ext_ref = ?, updated_at = ?, done_at = CASE WHEN ? IN ('done', 'cancelled') THEN ? ELSE NULL END WHERE id = ?").bind(status, extRef, now, status, now, id),
        logStmt(env, user, 'update', 'part_request', id, label, changes(req, { status, ext_ref: extRef }, ['status', 'ext_ref'])),
      ]);
      return json({ ok: true });
    }
    // erp mode, by hand: the ERP handed the part out; its use and cost go on the request it was asked for.
    if (method === 'POST' && seg[2] === 'issue' && seg.length === 3) {
      if (mode !== 'erp') fail(409, 'inventory_mode');
      if (!req.ticket_id) fail(400, 'ticket_required');
      const body = await readJson(request);
      const qty = body.qty === undefined ? req.qty : qtyOf(body.qty);
      const unitCost = costOf(body.unit_cost);
      if (unitCost === null) fail(400, 'cost_required');
      const t = await env.DB.prepare('SELECT id, asset_id, requester_dept_id FROM tickets WHERE id = ?').bind(req.ticket_id).first();
      if (!t) fail(400, 'ticket_required');
      await env.DB.batch([...(await erpIssueStmts(env, req, t, qty, unitCost, null, 'ui', user.name, today)), logStmt(env, user, 'issue', 'part_request', id, label, { qty: [null, qty], unit_cost: [null, unitCost] })]);
      return json({ ok: true });
    }
    fail(404, 'not_found');
  }

  /* ---- what maintenance cost, by department (cost center) and device ---- */

  if (route === 'GET /inventory/costs') {
    const [from, to] = reportRange(url, today);
    return json({ mode, ...(await costReport(env, settings, from, to)) });
  }

  return null;
}

/* daily: parts at or below their minimum */

export const STOCK_TEXT = {
  ar: {
    subject: (n, app) => `قطع غيار بلغت الحد الأدنى (${n}) - ${app}`,
    title: 'قطع غيار بلغت الحد الأدنى',
    intro: 'القطع التالية بلغت الحد الأدنى أو أقل منه. فُتح طلب احتياج لكل منها.',
    cols: ['الكود', 'القطعة', 'المخزن', 'الرصيد', 'الحد الأدنى'],
    open: 'فتح طلبات الاحتياج',
    dir: 'rtl',
    footer: (app) => `رسالة تلقائية من نظام إدارة الأصول - ${app}.`,
  },
  en: {
    subject: (n, app) => `Spare parts at their minimum (${n}) - ${app}`,
    title: 'Spare parts at their minimum',
    intro: 'These parts are at or below their minimum. A part request was opened for each.',
    cols: ['Code', 'Part', 'Store', 'In stock', 'Minimum'],
    open: 'Open part requests',
    dir: 'ltr',
    footer: (app) => `Automatic message from Asset Management - ${app}.`,
  },
};

// Each fall to the minimum is emailed once (stock.alerted), to the asset managers, never the system admins.
export async function runStockReminders(env) {
  const settings = await getSettings(env);
  if (invMode(settings) === 'erp') return { low: 0, emails: 0 };
  await lowStockStmt(env, nowIso()).run();
  const { results: low } = await env.DB.prepare(
    `SELECT s.part_id, s.store_id, s.qty, p.code, p.name_ar, p.name_en, p.min_qty, st.name_ar AS store_ar, st.name_en AS store_en
       FROM stock s JOIN parts p ON p.id = s.part_id JOIN stores st ON st.id = s.store_id
      WHERE s.alerted = 0 AND p.active = 1 AND st.active = 1 AND p.min_qty > 0 AND s.qty <= p.min_qty ORDER BY p.code LIMIT 300`,
  ).all();
  if (!low.length) return { low: 0, emails: 0 };
  if (!mailReady(settings)) return { low: low.length, emails: 0, error: 'mail_not_configured' };
  const marks = env.DB.prepare(
    "UPDATE stock SET alerted = 1 WHERE (part_id, store_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
  ).bind(JSON.stringify(low.map((r) => [r.part_id, r.store_id])));
  const { results: people } = await env.DB.prepare("SELECT email FROM users WHERE active = 1 AND role NOT IN ('super_admin', 'systems_admin') AND assets_role = 'manager'").all();
  if (!people.length) {
    await marks.run();
    return { low: low.length, emails: 0 };
  }
  const link = `${settings.site_url || ''}/#/assets/requests`;
  const mail = bothLangs(settings, (s) => {
    const L = STOCK_TEXT[s.email_lang];
    const ar = s.email_lang === 'ar';
    const cell = `padding:6px 8px;border-bottom:1px solid #f1eadb;text-align:${ar ? 'right' : 'left'};font-size:14px`;
    const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${ar ? 'right' : 'left'}">${emailHeader(s)}<h2 style="font-size:17px">${escHtml(L.title)}</h2>
      <p>${escHtml(L.intro)}</p>
      <table style="border-collapse:collapse;width:100%"><tr>${L.cols.map((c) => `<th style="${cell};background:#f6f0e2">${escHtml(c)}</th>`).join('')}</tr>
      ${low.map((r) => `<tr><td style="${cell}" dir="ltr">${escHtml(r.code)}</td><td style="${cell}">${escHtml(ar ? r.name_ar : r.name_en)}</td><td style="${cell}">${escHtml(ar ? r.store_ar : r.store_en)}</td><td style="${cell};color:#a8443a"><b>${escHtml(String(r.qty))}</b></td><td style="${cell}">${escHtml(String(r.min_qty))}</td></tr>`).join('')}</table>
      <p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
      <p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(appName(s, s.email_lang)))}</p></div>`;
    return { subject: L.subject(low.length, appName(s, s.email_lang)), html };
  });
  const result = await sendMail(settings, people.map((p) => ({ to: p.email, ...mail })));
  await env.DB.batch([
    ...(result.ok ? [marks] : []),
    logStmt(env, null, result.ok ? 'remind' : 'remind_failed', 'stock', null, null, result.ok ? { items: low.length, emails: people.length } : { error: result.error }),
  ]);
  return { low: low.length, emails: result.ok ? people.length : 0 };
}

/* daily: contracts about to end, and suppliers' papers about to expire */

export const CONTRACT_TEXT = {
  ar: {
    subject: (n, app) => `تنبيه العقود ووثائق الموردين (${n}) - ${app}`,
    title: 'عقود ووثائق تحتاج إلى متابعة',
    ending: 'عقود قاربت على الانتهاء',
    docs: 'وثائق موردين قاربت على الانتهاء أو انتهت',
    days: (d) => (d < 0 ? `انتهت منذ ${-d} يوم` : d === 0 ? 'تنتهي اليوم' : `باقي ${d} يوم`),
    kind: { cr: 'السجل التجاري', zakat: 'شهادة الزكاة والدخل', gosi: 'شهادة التأمينات الاجتماعية', sfda: 'ترخيص هيئة الغذاء والدواء', insurance: 'وثيقة التأمين', other: 'وثيقة أخرى' },
    open: 'فتح العقود',
    dir: 'rtl',
    footer: (app) => `رسالة تلقائية من نظام إدارة الأصول - ${app}.`,
  },
  en: {
    subject: (n, app) => `Contracts and supplier papers to follow up (${n}) - ${app}`,
    title: 'Contracts and papers that need attention',
    ending: 'Contracts ending soon',
    docs: 'Supplier papers expiring or expired',
    days: (d) => (d < 0 ? `expired ${-d} days ago` : d === 0 ? 'ends today' : `${d} days left`),
    kind: { cr: 'Commercial registration', zakat: 'Zakat certificate', gosi: 'GOSI certificate', sfda: 'SFDA licence', insurance: 'Insurance policy', other: 'Other paper' },
    open: 'Open contracts',
    dir: 'ltr',
    footer: (app) => `Automatic message from Asset Management - ${app}.`,
  },
};

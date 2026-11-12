// The integration API (/api/v1) and its keys.
import { readJson, requireRole } from '../lib/auth.js';
import { ADMIN_ROLES } from '../lib/config.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { HttpError, checkLang, fail, json, nowIso, sha256Hex, str, toHex, todayIn } from '../lib/util.js';
import { ASSET_SELECT, ASSET_STATUSES } from './assets.js';
import { statusOf } from './docs.js';
import { DOC_RE, PART_ROWS_MAX, RECEIPT_KINDS, REQUEST_SELECT, REQUEST_STATUSES, codeOf, costOf, costReport, erpIssueStmts, invMode, isConstraint, qtyOf, readPart, realertStmt, receiptLines, receiptStmts, reportRange } from './inventory.js';
import { handlePeople } from './people.js';
import { qualityHome } from './quality.js';
import { MAX_STAFF_ROWS, TICKET_SELECT, addMinutes, afterNewTicket, eventStmt, importStaff, slaFor, ticketOut, ticketPriority, toInt } from './tickets.js';

/* ------------------------- Integration API (v1) -------------------------- */

// Other systems (HR, the hospital information system) call /api/v1 with a key made in Admin Center.
// Each key has its own scopes, and is counted per hour so one busy system never slows the rest.
export const API_SCOPES = ['portal', 'staff', 'tickets_read', 'tickets_write', 'assets_read', 'inventory', 'costs_read', 'docs_read'];
export const API_PER_HOUR = 1000; // calls per key and hour
export const API_KEYS_MAX = 20;
export const API_LIST_MAX = 200; // rows per call on the list routes
export const API_KEY_RE = /^fms_[0-9a-f]{40}$/;

export const apiKeyOut = (k) => ({
  id: k.id,
  name_ar: k.name_ar,
  name_en: k.name_en,
  prefix: k.prefix,
  scopes: k.scopes ? k.scopes.split(',') : [],
  active: !!k.active,
  used_n: k.used_n,
  last_used_at: k.last_used_at,
  created_by: k.created_by,
  created_at: k.created_at,
});

// A ticket as another system sees it: what happened and when, without the notes technicians write to each other.
export function apiTicketOut(t, now) {
  const o = ticketOut(t, now);
  return {
    id: o.id,
    status: o.status,
    priority: o.priority,
    patient_impact: o.patient_impact,
    category: { id: o.category_id, name_ar: o.cat_ar, name_en: o.cat_en },
    team: { id: o.team_id, name_ar: o.team_ar, name_en: o.team_en },
    requester: { emp_no: o.requester_emp_no, name: o.requester_name, department_id: o.requester_dept_id },
    location: { id: o.location_id, name_ar: o.loc_ar, name_en: o.loc_en, text: o.location_text },
    asset_tag: o.asset_tag || null,
    description: o.description,
    work_order: !!o.pm_plan_id,
    assignee: o.assignee_name_en || null,
    created_at: o.created_at,
    received_at: o.received_at,
    expected_at: o.expected_at,
    response_due: o.response_due,
    resolve_due: o.resolve_due,
    closed_at: o.closed_at,
    resolution: o.resolution,
    close_code: o.close_code,
    rating: o.rating,
    late: o.late,
    sla_met: o.sla_met,
    updated_at: o.updated_at,
  };
}

export const apiAssetOut = (a) => ({
  id: a.id,
  tag: a.tag,
  name_ar: a.name_ar,
  name_en: a.name_en,
  type: { id: a.type_id || null, name_ar: a.type_ar || '', name_en: a.type_en || '' },
  department_id: a.department_id,
  location: { id: a.location_id, name_ar: a.loc_ar || '', name_en: a.loc_en || '' },
  manufacturer: a.manufacturer,
  model: a.model,
  serial_no: a.serial_no,
  purchase_date: a.purchase_date,
  warranty_end: a.warranty_end,
  status: a.status,
  risk: a.risk,
  next_pm: a.next_pm,
  open_faults: a.open_faults,
  updated_at: a.updated_at,
});

export async function handleIntegration(request, env, url, seg, method, ctx) {
  const auth = (request.headers.get('Authorization') || '').trim();
  const raw = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : str(request.headers.get('X-API-Key'), 60);
  if (!API_KEY_RE.test(raw)) fail(401, 'api_key_required');
  const now = nowIso();
  const hour = now.slice(0, 13);
  // One query finds the key, counts the call and keeps the hourly count.
  const key = await env.DB.prepare(
    `UPDATE api_keys SET used_n = used_n + 1, last_used_at = ?1, hour_n = CASE WHEN hour_key = ?2 THEN hour_n + 1 ELSE 1 END, hour_key = ?2
      WHERE key_hash = ?3 AND active = 1 RETURNING *`,
  )
    .bind(now, hour, await sha256Hex(raw))
    .first();
  if (!key) fail(401, 'api_key_invalid');
  if (key.hour_n > API_PER_HOUR) fail(429, 'too_many_requests');
  const scopes = key.scopes.split(',');
  const need = (scope) => {
    if (!scopes.includes(scope)) fail(403, 'api_scope');
  };
  const actor = { id: null, name: `API: ${key.name_en}` };
  const rest = seg.slice(1);
  const route = `${method} /${rest.join('/')}`;
  const limit = Math.min(API_LIST_MAX, Math.max(1, toInt(url.searchParams.get('limit')) || 100));

  // Accounts and roles from the Fikra portal's users screen (systems/people.js).
  if (rest[0] === 'people' && rest.length === 1) {
    need('portal');
    return handlePeople(request, env, url, method, actor);
  }
  if (route === 'GET /ping') return json({ ok: true, name_ar: key.name_ar, name_en: key.name_en, scopes, per_hour: API_PER_HOUR, used_this_hour: key.hour_n });

  // A few numbers for this system's card on the Fikra portal page (the operations system links to it). Any key.
  if (route === 'GET /summary') {
    const q = await qualityHome(env);
    return json({
      system: 'quality',
      icon: 'award',
      stats: [
        { n: q.pct == null ? '-' : q.pct + '%', ar: 'جاهزية', en: 'readiness' },
        { n: q.capa_open, ar: 'إجراء تصحيحي', en: 'corrective actions', alert: q.capa_late > 0 },
      ],
    });
  }

  /* reference lists, for any key: the ids other routes take */

  if (route === 'GET /departments') {
    const { results } = await env.DB.prepare('SELECT id, name_ar, name_en, is_team FROM departments ORDER BY id').all();
    return json({ departments: results.map((d) => ({ ...d, is_team: !!d.is_team })) });
  }
  // A place's QR code proves someone stands there, so it is never handed out.
  if (route === 'GET /locations') {
    const { results } = await env.DB.prepare('SELECT id, name_ar, name_en, department_id FROM locations WHERE active = 1 ORDER BY id').all();
    return json({ locations: results });
  }
  if (route === 'GET /categories') {
    const { results } = await env.DB.prepare('SELECT id, name_ar, name_en, team_id, priority FROM ticket_categories WHERE active = 1 AND pm = 0 ORDER BY id').all();
    return json({ categories: results });
  }

  /* staff list: HR keeps it up to date */

  if (route === 'GET /staff') {
    need('staff');
    const { results } = await env.DB.prepare('SELECT emp_no, name, name_en, department_id, phone, email, job_title, active, updated_at FROM staff ORDER BY emp_no').all();
    return json({ staff: results.map((m) => ({ ...m, active: !!m.active })) });
  }
  // rows: [{ emp_no, name, name_en, department_id or department (its Arabic or English name), phone, email, job_title, active }].
  // full: true = this is everyone; anyone not in rows is switched off.
  if (route === 'POST /staff') {
    need('staff');
    const body = await readJson(request);
    if (!Array.isArray(body.rows)) fail(400, 'bad_request');
    if (body.rows.length > MAX_STAFF_ROWS) fail(413, 'too_many_rows');
    const { results: depts } = await env.DB.prepare('SELECT id, name_ar, name_en FROM departments').all();
    const byName = new Map();
    for (const d of depts) {
      byName.set(d.name_ar.trim(), d.id);
      byName.set(d.name_en.trim().toLowerCase(), d.id);
    }
    const ids = new Set(depts.map((d) => d.id));
    const rows = body.rows.map((r) => {
      if (!r || typeof r !== 'object') return null;
      const id = toInt(r.department_id);
      const named = str(r.department, 100);
      const department_id = id && ids.has(id) ? id : named ? byName.get(named) || byName.get(named.toLowerCase()) || null : null;
      // Many HR systems send the employee number as a number.
      return { ...r, emp_no: typeof r.emp_no === 'number' ? String(r.emp_no) : r.emp_no, department_id };
    });
    const keep = body.full === true ? rows.map((r) => r && r.emp_no).filter((v) => typeof v === 'string') : null;
    return json(await importStaff(env, actor, rows, keep));
  }

  /* tickets: open a request from another system, and follow it */

  if (route === 'POST /tickets') {
    need('tickets_write');
    const body = await readJson(request);
    const settings = await getSettings(env);
    const emp_no = str(body.emp_no, 30);
    const name = str(body.name, 100);
    const phone = str(body.phone, 30);
    const description = str(body.description, 2000);
    const asset_tag = str(body.asset_tag, 60);
    const location_text = str(body.location_text, 200);
    const category_id = toInt(body.category_id);
    const location_id = toInt(body.location_id);
    const impact = body.patient_impact === true || body.patient_impact === 1 ? 1 : 0;
    if (!emp_no) fail(400, 'requester_required');
    if (!description) fail(400, 'description_required');
    const [cat, staffCount, member, loc, assetRow] = await Promise.all([
      category_id ? env.DB.prepare('SELECT * FROM ticket_categories WHERE id = ? AND active = 1 AND pm = 0').bind(category_id).first() : null,
      env.DB.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1').first(),
      env.DB.prepare('SELECT * FROM staff WHERE emp_no = ?').bind(emp_no).first(),
      location_id ? env.DB.prepare('SELECT id FROM locations WHERE id = ? AND active = 1').bind(location_id).first() : null,
      asset_tag ? env.DB.prepare('SELECT id FROM assets WHERE tag = ?').bind(asset_tag).first() : null,
    ]);
    if (!cat) fail(400, 'type_required');
    if (location_id && !loc) fail(400, 'bad_location');
    // The same rule as the request page: once a staff list exists, the employee number names the person.
    const listed = staffCount.n > 0;
    if (listed && (!member || !member.active)) fail(403, 'staff_unknown');
    if (!listed && !name) fail(400, 'requester_required');
    const deptId = listed && member.department_id ? member.department_id : toInt(body.department_id);
    const dept = deptId ? await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(deptId).first() : null;
    if (!dept) fail(400, 'department_required');
    const priority = ticketPriority(cat.priority, impact);
    const sla = slaFor(settings, priority);
    const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const res = await env.DB.prepare(
      `INSERT INTO tickets (status, priority, patient_impact, category_id, team_id, staff_id, requester_emp_no, requester_name, requester_dept_id, requester_phone,
                            location_id, location_text, asset_tag, asset_id, description, response_due, resolve_due, track_hash, ip_hash, created_at, updated_at)
       VALUES ('new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        priority, impact, cat.id, cat.team_id, member ? member.id : null, emp_no, listed ? member.name : name, dept.id, phone || (member && member.phone) || null,
        loc ? loc.id : null, location_text || null, asset_tag || null, assetRow ? assetRow.id : null, description,
        addMinutes(now, sla.resp), addMinutes(now, sla.res), await sha256Hex(token), `api:${key.id}`, now, now,
      )
      .run();
    const id = res.meta.last_row_id;
    await eventStmt(env, id, actor, 'created').run();
    ctx.waitUntil(afterNewTicket(env, 'new', id));
    return json({ ok: true, id, priority, track_url: `${url.origin}/#/track/${id}/${token}` }, 201);
  }

  // status: open (anything not closed) or one status. since: changed after this time, oldest first, for
  // picking up changes in rounds (pass the last updated_at back as since). Without since: newest first.
  if (route === 'GET /tickets') {
    need('tickets_read');
    const where = [];
    const binds = [];
    const status = str(url.searchParams.get('status'), 20);
    if (status === 'open') where.push("t.status <> 'closed'");
    else if (['new', 'in_progress', 'on_hold', 'closed'].includes(status)) {
      where.push('t.status = ?');
      binds.push(status);
    } else if (status) fail(400, 'bad_request');
    const since = str(url.searchParams.get('since'), 40);
    if (since) {
      if (Number.isNaN(Date.parse(since))) fail(400, 'bad_request');
      where.push('t.updated_at > ?');
      binds.push(new Date(since).toISOString());
    }
    const emp = str(url.searchParams.get('emp_no'), 30);
    if (emp) {
      where.push('t.requester_emp_no = ?');
      binds.push(emp);
    }
    const sql = `${TICKET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${since ? 't.updated_at ASC, t.id ASC' : 't.id DESC'} LIMIT ${limit + 1}`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ tickets: results.slice(0, limit).map((t) => apiTicketOut(t, now)), more: results.length > limit });
  }

  if (method === 'GET' && rest[0] === 'tickets' && rest.length === 2 && /^\d+$/.test(rest[1])) {
    need('tickets_read');
    const id = Number(rest[1]);
    const t = await env.DB.prepare(TICKET_SELECT + ' WHERE t.id = ?').bind(id).first();
    if (!t) fail(404, 'not_found');
    const { results: events } = await env.DB.prepare(
      "SELECT at, actor, kind, note FROM ticket_events WHERE ticket_id = ? AND kind IN ('created', 'received', 'assigned', 'hold', 'resume', 'closed', 'reopened', 'feedback') ORDER BY id",
    ).bind(id).all();
    return json({ ticket: apiTicketOut(t, now), events: events.map((e) => ({ at: e.at, kind: e.kind, actor: e.actor, note: e.kind === 'hold' || e.kind === 'closed' ? e.note : null })) });
  }

  /* documents: the register and its PDFs, for a system that shows them as evidence (the quality system) */

  if (route === 'GET /documents') {
    need('docs_read');
    const settings = await getSettings(env);
    const today = todayIn(settings.timezone);
    const after = toInt(url.searchParams.get('after_id'));
    const { results } = await env.DB.prepare(
      `SELECT f.*, d.name_ar AS dept_ar, d.name_en AS dept_en, t.name_ar AS type_ar, t.name_en AS type_en
         FROM files f LEFT JOIN departments d ON d.id = f.department_id LEFT JOIN doc_types t ON t.key = f.doc_type
        ${after ? 'WHERE f.id > ?' : ''} ORDER BY f.id LIMIT ${limit + 1}`,
    )
      .bind(...(after ? [after] : []))
      .all();
    const out = (f) => {
      const st = statusOf(f, today, settings.near_days);
      return {
        id: f.id, file_number: f.file_number, name_ar: f.name, name_en: f.name_en || '', doc_type: f.doc_type, type_ar: f.type_ar, type_en: f.type_en,
        department_id: f.department_id, department_ar: f.dept_ar, department_en: f.dept_en, issue_date: f.issue_date, expiry_date: f.expiry_date,
        status: st.status, days_left: st.days, has_pdf: !!f.pdf_key, pdf_size: f.pdf_size, updated_at: f.updated_at,
      };
    };
    return json({ documents: results.slice(0, limit).map(out), more: results.length > limit });
  }
  if (method === 'GET' && rest[0] === 'documents' && rest.length === 3 && /^\d+$/.test(rest[1]) && rest[2] === 'pdf') {
    need('docs_read');
    const f = await env.DB.prepare('SELECT pdf_key, pdf_name FROM files WHERE id = ?').bind(Number(rest[1])).first();
    if (!f || !f.pdf_key) fail(404, 'not_found');
    const obj = await env.FILES.get(f.pdf_key);
    if (!obj) fail(404, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }

  /* assets: the register, for the systems that show a device's state */

  if (route === 'GET /assets') {
    need('assets_read');
    const where = [];
    const binds = [];
    const status = str(url.searchParams.get('status'), 20);
    if (status) {
      if (!ASSET_STATUSES.includes(status)) fail(400, 'bad_request');
      where.push('a.status = ?');
      binds.push(status);
    }
    const after = toInt(url.searchParams.get('after_id'));
    if (after) {
      where.push('a.id > ?');
      binds.push(after);
    }
    const { results } = await env.DB.prepare(`${ASSET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id LIMIT ${limit + 1}`).bind(...binds).all();
    return json({ assets: results.slice(0, limit).map(apiAssetOut), more: results.length > limit });
  }
  if (method === 'GET' && rest[0] === 'assets' && rest.length === 2) {
    need('assets_read');
    const a = await env.DB.prepare(ASSET_SELECT + ' WHERE a.tag = ?').bind(decodeURIComponent(rest[1]).slice(0, 60)).first();
    if (!a) fail(404, 'not_found');
    return json({ asset: apiAssetOut(a) });
  }

  /* spare parts: the ERP keeps the catalogue and the main warehouse, and takes the costs */

  if (['parts', 'stores', 'stock', 'receipts', 'part-requests', 'costs'].includes(rest[0])) {
    need(rest[0] === 'costs' ? 'costs_read' : 'inventory');
    const settings = await getSettings(env);
    const mode = invMode(settings);
    const today = todayIn(settings.timezone);

    if (route === 'GET /parts') {
      const { results } = await env.DB.prepare(
        'SELECT p.id, p.code, p.erp_code, p.name_ar, p.name_en, p.unit, p.min_qty, p.reorder_qty, p.unit_cost, p.active, p.updated_at, COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.part_id = p.id), 0) AS qty FROM parts p ORDER BY p.code',
      ).all();
      return json({ mode, parts: results.map((p) => ({ ...p, active: !!p.active })) });
    }
    // rows: [{ code, name_ar, name_en, unit, min_qty, reorder_qty, erp_code, active }], matched on code.
    // A bad row is reported and left out; the others are saved in one statement.
    if (route === 'POST /parts') {
      const body = await readJson(request);
      if (!Array.isArray(body.rows) || !body.rows.length) fail(400, 'bad_request');
      if (body.rows.length > PART_ROWS_MAX) fail(413, 'too_many_rows');
      const clean = new Map();
      const errors = [];
      body.rows.forEach((r, i) => {
        try {
          if (!r || typeof r !== 'object') fail(400, 'bad_request');
          const p = readPart({ ...r, code: typeof r.code === 'number' ? String(r.code) : r.code });
          // Fields left out keep what is saved here (the minimum levels are often set by the maintenance team).
          for (const k of ['min_qty', 'reorder_qty']) if (r[k] === undefined) p[k] = -1;
          if (r.unit === undefined) p.unit = '';
          if (r.erp_code === undefined) p.erp_code = '';
          clean.set(p.code, p);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          errors.push({ row: i + 1, code: r && typeof r.code === 'string' ? r.code.slice(0, 40) : null, error: e.code });
        }
      });
      const rows = [...clean.values()];
      let added = 0;
      if (rows.length) {
        const known = new Set(
          (await env.DB.prepare('SELECT code FROM parts WHERE code IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map((p) => p.code))).all()).results.map((p) => p.code),
        );
        added = rows.filter((p) => !known.has(p.code)).length;
        const now = nowIso();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO parts (code, name_ar, name_en, unit, min_qty, reorder_qty, erp_code, active, created_at, updated_at)
             SELECT json_extract(value, '$.code'), json_extract(value, '$.name_ar'), json_extract(value, '$.name_en'), json_extract(value, '$.unit'),
                    json_extract(value, '$.min_qty'), json_extract(value, '$.reorder_qty'), json_extract(value, '$.erp_code'), json_extract(value, '$.active'), ?2, ?2
               FROM json_each(?1) WHERE 1
             ON CONFLICT (code) DO UPDATE SET name_ar = excluded.name_ar, name_en = excluded.name_en,
               unit = CASE WHEN excluded.unit = '' THEN parts.unit ELSE excluded.unit END,
               min_qty = CASE WHEN excluded.min_qty < 0 THEN parts.min_qty ELSE excluded.min_qty END,
               reorder_qty = CASE WHEN excluded.reorder_qty < 0 THEN parts.reorder_qty ELSE excluded.reorder_qty END,
               erp_code = CASE WHEN excluded.erp_code = '' THEN parts.erp_code ELSE excluded.erp_code END,
               active = excluded.active, updated_at = excluded.updated_at`,
          ).bind(JSON.stringify(rows), now),
          // New parts sent without those fields get the usual defaults.
          env.DB.prepare("UPDATE parts SET min_qty = MAX(min_qty, 0), reorder_qty = MAX(reorder_qty, 0), unit = CASE WHEN unit = '' THEN 'piece' ELSE unit END, erp_code = NULLIF(erp_code, '') WHERE min_qty < 0 OR reorder_qty < 0 OR unit = '' OR erp_code = ''"),
          realertStmt(env),
          logStmt(env, actor, 'import', 'part', null, null, { added: [null, added], updated: [null, rows.length - added] }),
        ]);
      }
      return json({ ok: true, added, updated: rows.length - added, errors });
    }
    if (route === 'GET /stores') {
      const { results } = await env.DB.prepare('SELECT id, name_ar, name_en, erp_code, active FROM stores ORDER BY id').all();
      return json({ mode, stores: results.map((s) => ({ ...s, active: !!s.active })) });
    }
    if (route === 'GET /stock') {
      const { results } = await env.DB.prepare(
        'SELECT p.code, p.erp_code, st.id AS store_id, st.erp_code AS store_code, s.qty, p.min_qty, p.unit_cost FROM stock s JOIN parts p ON p.id = s.part_id JOIN stores st ON st.id = s.store_id ORDER BY p.code, st.id',
      ).all();
      return json({ mode, stock: results.map((r) => ({ ...r, low: r.min_qty > 0 && r.qty <= r.min_qty })) });
    }
    // A transfer from the main warehouse, or a purchase, into a store here. ext_id is the ERP's own number for it:
    // sending the same one again changes nothing, so a call cut off half way can simply be repeated.
    if (route === 'POST /receipts') {
      if (mode === 'erp') fail(409, 'inventory_mode');
      const body = await readJson(request);
      checkLang((k) => body[k], [], ['ext_id', 'doc_no', 'invoice_no', 'store']);
      const extId = codeOf(body.ext_id, DOC_RE, 'invalid_doc_no');
      if (!extId) fail(400, 'ext_id_required');
      const kind = body.kind === 'transfer' || body.kind === 'transfer_in' ? 'transfer_in' : body.kind === 'purchase' ? 'purchase' : null;
      if (!kind) fail(400, 'invalid_kind');
      if (!RECEIPT_KINDS[mode].includes(kind)) fail(409, 'inventory_mode');
      const doc_no = codeOf(body.doc_no, DOC_RE, 'invalid_doc_no');
      const invoice_no = codeOf(body.invoice_no, DOC_RE, 'invalid_doc_no');
      if (kind === 'transfer_in' && !doc_no) fail(400, 'doc_required');
      if (kind === 'purchase' && !doc_no && !invoice_no) fail(400, 'doc_required');
      if (await env.DB.prepare('SELECT 1 AS x FROM stock_moves WHERE ext_id = ? LIMIT 1').bind(extId).first()) return json({ ok: true, duplicate: true });
      const storeCode = str(body.store, 40);
      const store = toInt(body.store_id)
        ? await env.DB.prepare('SELECT id, name_ar FROM stores WHERE id = ? AND active = 1').bind(toInt(body.store_id)).first()
        : storeCode
          ? await env.DB.prepare('SELECT id, name_ar FROM stores WHERE erp_code = ? AND active = 1').bind(storeCode).first()
          : await env.DB.prepare('SELECT id, name_ar FROM stores WHERE active = 1 ORDER BY id LIMIT 2').all().then((r) => (r.results.length === 1 ? r.results[0] : null));
      if (!store) fail(400, 'store_required');
      const got = await receiptLines(env, body.lines, true);
      if (got.missing) return json({ error: 'part_unknown', codes: got.missing }, 400);
      const requestIds = [...new Set((Array.isArray(body.request_ids) ? body.request_ids : body.request_id ? [body.request_id] : []).map(toInt).filter((n) => n > 0))].slice(0, 50);
      const now = nowIso();
      try {
        await env.DB.batch([
          ...receiptStmts(env, { kind, store_id: store.id, lines: got.lines, doc_no, invoice_no, vendor_id: null, request_ids: requestIds, batch: crypto.randomUUID(), ext_id: extId, source: 'api', note: str(body.note, 300), user_name: actor.name, now }),
          logStmt(env, actor, 'receive', 'stock', store.id, store.name_ar, { kind: [null, kind], lines: [null, got.lines.length], doc_no: [null, doc_no || invoice_no] }),
        ]);
      } catch (e) {
        // The same receipt sent twice at once: the unique index keeps one.
        if (isConstraint(e)) return json({ ok: true, duplicate: true });
        throw e;
      }
      return json({ ok: true, lines: got.lines.length }, 201);
    }
    // status: active (open and sent, the default), or one status. since: changed after this time, oldest first.
    if (route === 'GET /part-requests') {
      const status = str(url.searchParams.get('status'), 20) || 'active';
      const where = [];
      const binds = [];
      if (status === 'active') where.push("r.status IN ('open', 'sent')");
      else if (REQUEST_STATUSES.includes(status)) {
        where.push('r.status = ?');
        binds.push(status);
      } else if (status !== 'all') fail(400, 'bad_request');
      const since = str(url.searchParams.get('since'), 40);
      if (since) {
        if (Number.isNaN(Date.parse(since))) fail(400, 'bad_request');
        where.push('r.updated_at > ?');
        binds.push(new Date(since).toISOString());
      }
      const { results } = await env.DB.prepare(`${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${since ? 'r.updated_at, r.id' : 'r.id DESC'} LIMIT ${limit + 1}`).bind(...binds).all();
      return json({
        mode,
        requests: results.slice(0, limit).map((r) => ({
          id: r.id,
          part: { code: r.code, erp_code: r.erp_code, name_ar: r.name_ar, name_en: r.name_en, unit: r.unit },
          store: r.store_id ? { id: r.store_id, erp_code: r.store_code, name_ar: r.store_ar, name_en: r.store_en } : null,
          qty: r.qty,
          reason: r.reason,
          ticket_id: r.ticket_id,
          asset_tag: r.asset_tag || null,
          status: r.status,
          ext_ref: r.ext_ref,
          note: r.note,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })),
        more: results.length > limit,
      });
    }
    if (rest[0] === 'part-requests' && /^\d+$/.test(rest[1] || '') && method === 'POST') {
      const req = await env.DB.prepare(REQUEST_SELECT + ' WHERE r.id = ?').bind(Number(rest[1])).first();
      if (!req) fail(404, 'not_found');
      if (req.status === 'done' || req.status === 'cancelled') fail(409, 'request_closed');
      const body = await readJson(request);
      checkLang((k) => body[k], [], ['ext_ref', 'ext_id']);
      const label = `${req.name_ar} (${req.code})`;
      // The ERP took the request (sent), or closed it on its side.
      if (rest.length === 2) {
        const status = ['sent', 'done', 'cancelled'].includes(body.status) ? body.status : null;
        if (!status) fail(400, 'bad_request');
        const extRef = body.ext_ref === undefined ? req.ext_ref : codeOf(body.ext_ref, DOC_RE, 'invalid_doc_no');
        const now = nowIso();
        await env.DB.batch([
          env.DB.prepare("UPDATE part_requests SET status = ?, ext_ref = ?, updated_at = ?, done_at = CASE WHEN ? IN ('done', 'cancelled') THEN ? ELSE NULL END WHERE id = ?").bind(status, extRef, now, status, now, req.id),
          logStmt(env, actor, 'update', 'part_request', req.id, label, changes(req, { status, ext_ref: extRef }, ['status', 'ext_ref'])),
        ]);
        return json({ ok: true });
      }
      // erp mode: the ERP handed the part out for a request; its use and cost go on that request.
      if (rest.length === 3 && rest[2] === 'issue') {
        if (mode !== 'erp') fail(409, 'inventory_mode');
        if (!req.ticket_id) fail(400, 'ticket_required');
        const extId = codeOf(body.ext_id, DOC_RE, 'invalid_doc_no');
        if (!extId) fail(400, 'ext_id_required');
        const qty = body.qty === undefined ? req.qty : qtyOf(body.qty);
        const unitCost = costOf(body.unit_cost);
        if (unitCost === null) fail(400, 'cost_required');
        const t = await env.DB.prepare('SELECT id, asset_id, requester_dept_id FROM tickets WHERE id = ?').bind(req.ticket_id).first();
        if (!t) fail(400, 'ticket_required');
        try {
          await env.DB.batch([...(await erpIssueStmts(env, req, t, qty, unitCost, extId, 'api', actor.name, today)), logStmt(env, actor, 'issue', 'part_request', req.id, label, { qty: [null, qty], unit_cost: [null, unitCost] })]);
        } catch (e) {
          if (isConstraint(e)) return json({ ok: true, duplicate: true });
          throw e;
        }
        return json({ ok: true }, 201);
      }
    }
    // Maintenance cost by cost center, for the ERP to post: from and to are days (YYYY-MM-DD), up to a year.
    if (route === 'GET /costs') {
      const [from, to] = reportRange(url, today);
      const r = await costReport(env, settings, from, to);
      return json({
        mode,
        from,
        to,
        currency: 'SAR',
        total: r.total,
        covered_by_suppliers: r.covered,
        cost_centers: r.by_dept.map((d) => ({ cost_center: d.cost_center || null, department_id: d.dept_id, name_ar: d.dept_ar || '', name_en: d.dept_en || '', cost: d.cost, covered: d.covered })),
        lines: r.lines.map((m) => ({
          id: m.id,
          day: m.day,
          kind: m.kind,
          part_code: m.code,
          part_erp_code: m.erp_code,
          qty: m.qty,
          unit_cost: m.unit_cost,
          cost: m.cost,
          ticket_id: m.ticket_id,
          asset_tag: m.asset_tag || null,
          cost_center: m.cost_center || null,
          department_id: m.dept_id,
          charged_to: m.covered ? 'supplier' : 'department',
          vendor: m.covered ? m.vendor_en : null,
        })),
        more: r.more,
      });
    }
  }

  fail(404, 'not_found');
}

/* the keys, managed by the super admin in Admin Center */

// Keys open the site's data to other systems, so only the owner makes or sees them.
export async function handleApiKeys(request, env, url, seg, method, user) {
  requireRole(user, ...ADMIN_ROLES);
  const ownerId = (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
  if (user.id !== ownerId) fail(403, 'owner_only');
  const readKey = async () => {
    const body = await readJson(request);
    const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100), scopes: Array.isArray(body.scopes) ? API_SCOPES.filter((s) => body.scopes.includes(s)) : [] };
    if (!next.name_ar || !next.name_en) fail(400, 'name_required');
    if (!next.scopes.length) fail(400, 'scope_required');
    return { ...next, active: body.active === false ? 0 : 1 };
  };
  if (method === 'GET' && seg.length === 1) {
    const { results } = await env.DB.prepare('SELECT * FROM api_keys ORDER BY id DESC').all();
    return json({ keys: results.map(apiKeyOut), scopes: API_SCOPES, per_hour: API_PER_HOUR, base: `${url.origin}/api/v1` });
  }
  if (method === 'POST' && seg.length === 1) {
    const next = await readKey();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys').first();
    if (count.n >= API_KEYS_MAX) fail(409, 'too_many_keys');
    const key = 'fms_' + toHex(crypto.getRandomValues(new Uint8Array(20)));
    const res = await env.DB.prepare('INSERT INTO api_keys (name_ar, name_en, prefix, key_hash, scopes, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(next.name_ar, next.name_en, key.slice(0, 10), await sha256Hex(key), next.scopes.join(','), user.name, nowIso())
      .run();
    await logStmt(env, user, 'create', 'api_key', res.meta.last_row_id, next.name_ar, { scopes: [null, next.scopes.join(', ')] }).run();
    // The only time the key is ever shown.
    return json({ ok: true, id: res.meta.last_row_id, key });
  }
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  const row = id !== null ? await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first() : null;
  if (!row) fail(404, 'not_found');
  if (method === 'PUT' && seg.length === 2) {
    const next = await readKey();
    const scopes = next.scopes.join(',');
    await env.DB.batch([
      env.DB.prepare('UPDATE api_keys SET name_ar = ?, name_en = ?, scopes = ?, active = ? WHERE id = ?').bind(next.name_ar, next.name_en, scopes, next.active, id),
      logStmt(env, user, 'update', 'api_key', id, next.name_ar, changes(row, { ...next, scopes }, ['name_ar', 'name_en', 'scopes', 'active'])),
    ]);
    return json({ ok: true });
  }
  if (method === 'DELETE' && seg.length === 2) {
    await env.DB.batch([env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'api_key', id, row.name_ar)]);
    return json({ ok: true });
  }
  fail(405, 'method_not_allowed');
}

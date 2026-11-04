// Asset Management: assets, asset types and planned maintenance.
import { readJson } from '../lib/auth.js';
import { changes, getSettings, logStmt } from '../lib/db.js';
import { ARABIC_RE, LATIN_RE, fail, isDate, json, nowIso, optDate, sha256Hex, str, todayIn } from '../lib/util.js';
import { assetContract } from './contracts.js';
import { plusDays } from './docs.js';
import { addMinutes, afterNewTicket, pmCategory, slaFor, toInt } from './tickets.js';

/* ---------------------------- Asset Management --------------------------- */

export const ASSET_STATUSES = ['in_service', 'out_of_service', 'retired'];
export const ASSET_RISKS = ['high', 'medium', 'low'];
export const PM_KINDS = ['ppm', 'calibration', 'inspection'];
export const PM_PER_RUN = 5; // work orders opened per 15-minute run (the free plan limits queries per run)
export const MAX_ASSET_ROWS = 1000; // per import request
export const PM_TEXT = {
  ar: { ppm: 'صيانة وقائية', calibration: 'معايرة', inspection: 'فحص سلامة' },
  en: { ppm: 'Preventive maintenance', calibration: 'Calibration', inspection: 'Safety inspection' },
};

// Same day of the month n months later; the 31st becomes the last day of a shorter month.
export function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
// The next due date after a job: the old due date moved on by the plan's rhythm, past today.
export function nextPmDue(due, months, today) {
  let next = addMonths(due, months);
  for (let i = 0; next <= today && i < 600; i++) next = addMonths(next, months);
  return next;
}
// The end of a day in the organisation's time zone, as a UTC time.
export function endOfDay(day, tz) {
  const at = Date.parse(day + 'T23:59:00Z');
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at));
    const g = (k) => Number(p.find((x) => x.type === k).value);
    const offset = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - at;
    return new Date(at - offset).toISOString();
  } catch {
    return new Date(at).toISOString();
  }
}

// Opens the work orders that are due: a plan whose date is within its lead days and has no open order.
// Each order is a Service Desk ticket for the team of the asset's problem type, so the team works it with the rest.
export async function runPmJobs(env) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  const { results } = await env.DB.prepare(
    `SELECT p.*, a.tag, a.name_ar, a.name_en, a.risk, a.department_id, a.location_id, ty.team_id
       FROM pm_plans p JOIN assets a ON a.id = p.asset_id JOIN asset_types ty ON ty.id = a.type_id
      WHERE p.active = 1 AND a.status = 'in_service' AND date(p.next_due, '-' || p.lead_days || ' days') <= ?1
        AND (p.open_ticket_id IS NULL OR NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = p.open_ticket_id AND t.status <> 'closed'))
      ORDER BY p.next_due LIMIT ${PM_PER_RUN}`,
  )
    .bind(today)
    .all();
  const ids = [];
  const cats = new Map();
  for (const p of results) {
    if (!cats.has(p.team_id)) cats.set(p.team_id, await pmCategory(env, p.team_id));
    const now = nowIso();
    const priority = p.risk === 'high' ? 2 : 3;
    const sla = slaFor(settings, priority);
    const end = endOfDay(p.next_due, settings.timezone);
    const resolveDue = end > addMinutes(now, sla.resp) ? end : addMinutes(now, sla.res);
    const responseDue = addMinutes(resolveDue, -1440) > addMinutes(now, sla.resp) ? addMinutes(resolveDue, -1440) : addMinutes(now, sla.resp);
    const steps = String(p.checklist || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const description = [
      `${PM_TEXT.ar[p.kind] || PM_TEXT.ar.ppm}: ${p.name_ar} (${p.tag})`,
      `${PM_TEXT.en[p.kind] || PM_TEXT.en.ppm}: ${p.name_en}`,
      ...(steps.length ? ['', ...steps.map((s) => '- ' + s)] : []),
    ].join('\n');
    const res = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tickets (status, priority, patient_impact, category_id, team_id, requester_emp_no, requester_name, requester_dept_id, location_id, asset_tag, asset_id,
                              pm_plan_id, pm_due, description, response_due, resolve_due, track_hash, created_at, updated_at)
         VALUES ('new', ?, 0, ?, ?, '-', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(priority, cats.get(p.team_id), p.team_id, PM_TEXT.ar[p.kind] || PM_TEXT.ar.ppm, p.department_id, p.location_id, p.tag, p.asset_id, p.id, p.next_due, description, responseDue, resolveDue, await sha256Hex(crypto.randomUUID()), now, now),
      env.DB.prepare('UPDATE pm_plans SET open_ticket_id = last_insert_rowid() WHERE id = ?').bind(p.id),
      env.DB.prepare("INSERT INTO ticket_events (ticket_id, at, user_id, actor, kind, note, data) VALUES (last_insert_rowid(), ?, NULL, 'system', 'created', NULL, ?)").bind(now, JSON.stringify({ pm: p.kind })),
    ]);
    ids.push(res[0].meta.last_row_id);
  }
  for (const id of ids) await afterNewTicket(env, 'new', id);
  return { ok: true, opened: ids.length };
}

// Closing a planned job records it and moves the plan to its next date.
export async function pmClosedStmts(env, settings, t, user, result) {
  const plan = await env.DB.prepare('SELECT * FROM pm_plans WHERE id = ?').bind(t.pm_plan_id).first();
  if (!plan) return [];
  const today = todayIn(settings.timezone);
  const due = t.pm_due || plan.next_due;
  const stmts = [
    env.DB.prepare('INSERT INTO pm_done (plan_id, asset_id, kind, due, done_on, on_time, result, ticket_id, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      plan.id, plan.asset_id, plan.kind, due, today, today <= due && result === 'resolved' ? 1 : 0, result, t.id, user.name),
  ];
  // Only the order for the current date moves the plan on (an older order closed late does not skip a date).
  if (due === plan.next_due) {
    stmts.push(env.DB.prepare('UPDATE pm_plans SET last_done = ?, next_due = ?, open_ticket_id = NULL WHERE id = ?').bind(today, nextPmDue(due, plan.every_months, today), plan.id));
  }
  return stmts;
}

// Devices to watch: scored from their faults over the past year, the gap between faults, planned work
// that is overdue, the risk class and the age. A rule of thumb from the record, not a guarantee.
export const RISK_WATCH = 30; // a score from here is listed
export function riskScore(a, today) {
  const reasons = [];
  let score = 0;
  if (a.f90) {
    score += a.f90 * 20;
    reasons.push(['faults_90', a.f90]);
  }
  if (a.f365 >= 2) {
    score += a.f365 * 6;
    reasons.push(['faults_year', a.f365]);
  }
  let next = null;
  if (a.f365 >= 2) {
    // Average days between faults; the next one is expected that long after the last.
    const gap = Math.max(1, Math.round((Date.parse(a.last_fault) - Date.parse(a.first_fault)) / 86400000 / (a.f365 - 1)));
    next = new Date(Date.parse(a.last_fault) + gap * 86400000).toISOString().slice(0, 10);
    const left = Math.round((Date.parse(next) - Date.parse(today)) / 86400000);
    if (left >= 0 && left <= 30) {
      score += 15;
      reasons.push(['due_soon', gap]);
    }
    // Long past its usual gap without a new fault: no date to expect.
    if (left < 0) next = null;
  }
  if (a.next_pm && a.next_pm < today) {
    score += 15;
    reasons.push(['pm_overdue', a.next_pm]);
  }
  if (a.risk === 'high' && score) {
    score += 10;
    reasons.push(['high_risk', 1]);
  }
  const age = a.purchase_date ? (Date.parse(today) - Date.parse(a.purchase_date)) / (365.25 * 86400000) : 0;
  if (age >= 5 && score) {
    score += age >= 8 ? 10 : 5;
    reasons.push(['old', Math.floor(age)]);
  }
  score = Math.min(100, score);
  return { score, level: score >= 60 ? 'high' : score >= 40 ? 'medium' : 'low', reasons, next_fault: next };
}
export async function assetRisk(env, today) {
  const yearAgo = plusDays(today, -365);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.tag, a.name_ar, a.name_en, a.risk, a.status, a.purchase_date, d.name_ar AS dept_ar, d.name_en AS dept_en,
            f.f365, f.f90, f.first_fault, f.last_fault, f.open_faults,
            (SELECT MIN(p.next_due) FROM pm_plans p WHERE p.asset_id = a.id AND p.active = 1) AS next_pm,
            (SELECT COALESCE(SUM(-m.qty * m.unit_cost), 0) FROM stock_moves m WHERE m.asset_id = a.id AND m.kind IN ('issue', 'return') AND m.created_at >= ?1) AS parts_cost
       FROM (SELECT asset_id, COUNT(*) AS f365, COALESCE(SUM(created_at >= ?2), 0) AS f90, MIN(created_at) AS first_fault, MAX(created_at) AS last_fault,
                    COALESCE(SUM(status <> 'closed'), 0) AS open_faults
               FROM tickets WHERE asset_id IS NOT NULL AND pm_plan_id IS NULL AND created_at >= ?1 GROUP BY asset_id) f
       JOIN assets a ON a.id = f.asset_id AND a.status <> 'retired'
       LEFT JOIN departments d ON d.id = a.department_id`,
  ).bind(yearAgo, plusDays(today, -90)).all();
  return results
    .map((a) => ({ ...a, parts_cost: Math.round(a.parts_cost * 100) / 100, ...riskScore(a, today) }))
    .filter((a) => a.score >= RISK_WATCH)
    .sort((x, y) => y.score - x.score || y.f365 - x.f365)
    .slice(0, 30);
}

export const ASSET_SELECT = `SELECT a.*, ty.name_ar AS type_ar, ty.name_en AS type_en, ty.team_id, tm.name_ar AS team_ar, tm.name_en AS team_en,
       d.name_ar AS dept_ar, d.name_en AS dept_en, l.name_ar AS loc_ar, l.name_en AS loc_en, l.code AS loc_code,
       (SELECT MIN(p.next_due) FROM pm_plans p WHERE p.asset_id = a.id AND p.active = 1) AS next_pm,
       (SELECT COUNT(*) FROM tickets t WHERE t.asset_id = a.id AND t.status <> 'closed' AND t.pm_plan_id IS NULL) AS open_faults
  FROM assets a
  LEFT JOIN asset_types ty ON ty.id = a.type_id
  LEFT JOIN departments tm ON tm.id = ty.team_id
  LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN locations l ON l.id = a.location_id`;
// The place's QR code proves someone is there: only managers get it, to print the asset's QR.
export const assetOut = (a, manager) => {
  const o = { ...a };
  if (!manager) delete o.loc_code;
  return o;
};

export async function handleAssets(request, env, url, seg, method, user, ctx) {
  const role = user.assets;
  if (role === 'none') fail(403, 'forbidden');
  const manager = role === 'admin' || role === 'manager';
  const needManager = () => {
    if (!manager) fail(403, 'forbidden');
  };
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);

  // Register: every asset with its next planned date, plus what the forms and filters need.
  if (route2(method, seg) === 'GET /assets') {
    const [{ results: assets }, { results: types }, { results: departments }, { results: locations }, done] = await Promise.all([
      env.DB.prepare(ASSET_SELECT + ' ORDER BY a.tag LIMIT 5000').all(),
      env.DB.prepare('SELECT t.*, (SELECT COUNT(*) FROM assets a WHERE a.type_id = t.id) AS asset_count FROM asset_types t ORDER BY t.name_ar').all(),
      env.DB.prepare('SELECT id, name_ar, name_en, is_team FROM departments ORDER BY name_ar').all(),
      env.DB.prepare('SELECT id, name_ar, name_en, department_id, active FROM locations ORDER BY name_ar').all(),
      env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(on_time), 0) AS ok FROM pm_done WHERE done_on >= ?').bind(plusDays(today, -365)).first(),
    ]);
    return json({ assets: assets.map((a) => assetOut(a, manager)), types, departments, locations, today, compliance: done, can_manage: manager });
  }

  if (route2(method, seg) === 'GET /assets/risk') return json({ today, assets: await assetRisk(env, today) });

  // Planned work across all assets, for the maintenance schedule page.
  if (route2(method, seg) === 'GET /pm') {
    const [{ results: plans }, done] = await Promise.all([
      env.DB.prepare(
        `SELECT p.*, a.tag, a.name_ar, a.name_en, a.status AS asset_status, a.risk, d.name_ar AS dept_ar, d.name_en AS dept_en,
                tm.name_ar AS team_ar, tm.name_en AS team_en, t.status AS ticket_status
           FROM pm_plans p JOIN assets a ON a.id = p.asset_id
           LEFT JOIN departments d ON d.id = a.department_id
           LEFT JOIN asset_types ty ON ty.id = a.type_id
           LEFT JOIN departments tm ON tm.id = ty.team_id
           LEFT JOIN tickets t ON t.id = p.open_ticket_id
          ORDER BY p.next_due LIMIT 5000`,
      ).all(),
      env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(on_time), 0) AS ok FROM pm_done WHERE done_on >= ?').bind(plusDays(today, -365)).first(),
    ]);
    return json({ plans: plans.map((p) => ({ ...p, open_ticket_id: p.ticket_status && p.ticket_status !== 'closed' ? p.open_ticket_id : null })), today, compliance: done, can_manage: manager });
  }

  // Device types (managers): name and the team that looks after the device.
  if (seg[0] === 'asset-types') {
    needManager();
    const readType = async () => {
      const body = await readJson(request);
      const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100), team_id: toInt(body.team_id), active: body.active === false ? 0 : 1 };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      if (!next.team_id || !(await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND is_team = 1').bind(next.team_id).first())) fail(400, 'team_required');
      return next;
    };
    if (method === 'POST' && seg.length === 1) {
      const next = await readType();
      const res = await env.DB.prepare('INSERT INTO asset_types (name_ar, name_en, team_id, active, created_at) VALUES (?, ?, ?, ?, ?)').bind(next.name_ar, next.name_en, next.team_id, next.active, nowIso()).run();
      await logStmt(env, user, 'create', 'asset_type', res.meta.last_row_id, next.name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    const type = id !== null ? await env.DB.prepare('SELECT * FROM asset_types WHERE id = ?').bind(id).first() : null;
    if (!type) fail(404, 'not_found');
    if (method === 'PUT' && seg.length === 2) {
      const next = await readType();
      await env.DB.batch([
        env.DB.prepare('UPDATE asset_types SET name_ar = ?, name_en = ?, team_id = ?, active = ? WHERE id = ?').bind(next.name_ar, next.name_en, next.team_id, next.active, id),
        logStmt(env, user, 'update', 'asset_type', id, next.name_ar, changes(type, next, ['name_ar', 'name_en', 'team_id', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg.length === 2) {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE type_id = ?').bind(id).first();
      if (used.n > 0) fail(409, 'type_has_assets');
      await env.DB.batch([env.DB.prepare('DELETE FROM asset_types WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'asset_type', id, type.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  // Open the work orders that are due now, without waiting for the next 15-minute run.
  if (route2(method, seg) === 'POST /pm/run') {
    needManager();
    return json(await runPmJobs(env));
  }

  const readAsset = async (body) => {
    const next = {
      tag: str(body.tag, 60),
      name_ar: str(body.name_ar, 150),
      name_en: str(body.name_en, 150),
      type_id: toInt(body.type_id),
      department_id: toInt(body.department_id),
      location_id: toInt(body.location_id),
      manufacturer: str(body.manufacturer, 100) || null,
      model: str(body.model, 100) || null,
      serial_no: str(body.serial_no, 100) || null,
      purchase_date: optDate(body.purchase_date),
      warranty_end: optDate(body.warranty_end),
      status: ASSET_STATUSES.includes(body.status) ? body.status : 'in_service',
      risk: ASSET_RISKS.includes(body.risk) ? body.risk : 'medium',
      notes: str(body.notes, 1000) || null,
    };
    if (!next.tag) fail(400, 'tag_required');
    if (!next.name_ar || !next.name_en) fail(400, 'name_required');
    if (!next.type_id) fail(400, 'type_required');
    const [cat, dep, loc] = await Promise.all([
      env.DB.prepare('SELECT id FROM asset_types WHERE id = ?').bind(next.type_id).first(),
      next.department_id ? env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(next.department_id).first() : true,
      next.location_id ? env.DB.prepare('SELECT id FROM locations WHERE id = ?').bind(next.location_id).first() : true,
    ]);
    if (!cat) fail(400, 'category_required');
    if (!dep) fail(400, 'department_required');
    if (!loc) fail(400, 'location_required');
    return next;
  };
  const ASSET_KEYS = ['tag', 'name_ar', 'name_en', 'type_id', 'department_id', 'location_id', 'manufacturer', 'model', 'serial_no', 'purchase_date', 'warranty_end', 'status', 'risk', 'notes'];
  const tagTaken = async (tag, exceptId) => {
    if (await env.DB.prepare('SELECT id FROM assets WHERE tag = ? AND id <> ?').bind(tag, exceptId).first()) fail(409, 'tag_taken');
  };

  if (route2(method, seg) === 'POST /assets') {
    needManager();
    const next = await readAsset(await readJson(request));
    await tagTaken(next.tag, 0);
    const now = nowIso();
    const res = await env.DB.prepare(`INSERT INTO assets (${ASSET_KEYS.join(', ')}, created_at, updated_at) VALUES (${ASSET_KEYS.map(() => '?').join(', ')}, ?, ?)`)
      .bind(...ASSET_KEYS.map((k) => next[k]), now, now)
      .run();
    await logStmt(env, user, 'create', 'asset', res.meta.last_row_id, `${next.name_ar} (${next.tag})`).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  // Rows from an Excel sheet, matched by asset tag: new ones are added, known ones updated.
  // ppm_months / cal_months with their next dates create or update the asset's plans.
  if (route2(method, seg) === 'POST /assets/import') {
    needManager();
    const body = await readJson(request);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ASSET_ROWS) : [];
    const [{ results: cats }, { results: deps }, { results: locs }] = await Promise.all([
      env.DB.prepare('SELECT id FROM asset_types').all(),
      env.DB.prepare('SELECT id FROM departments').all(),
      env.DB.prepare('SELECT id FROM locations').all(),
    ]);
    const has = (list) => new Set(list.map((r) => r.id));
    const catIds = has(cats);
    const depIds = has(deps);
    const locIds = has(locs);
    const clean = [];
    const plans = [];
    const seen = new Set();
    const okDate = (v) => (isDate(str(v, 10)) ? str(v, 10) : null);
    const okMonths = (v) => {
      const n = toInt(v);
      return n && n > 0 && n <= 120 ? n : null;
    };
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const tag = str(r.tag, 60);
      const name_ar = str(r.name_ar, 150);
      const name_en = str(r.name_en, 150);
      const type_id = toInt(r.type_id);
      if (!tag || !name_ar || !name_en || !catIds.has(type_id) || seen.has(tag)) continue;
      if (ARABIC_RE.test(tag + name_en + (r.serial_no || '') + (r.model || '')) || LATIN_RE.test(name_ar)) continue;
      seen.add(tag);
      clean.push({
        tag, name_ar, name_en, type_id,
        department_id: depIds.has(toInt(r.department_id)) ? toInt(r.department_id) : null,
        location_id: locIds.has(toInt(r.location_id)) ? toInt(r.location_id) : null,
        manufacturer: str(r.manufacturer, 100) || null,
        model: str(r.model, 100) || null,
        serial_no: str(r.serial_no, 100) || null,
        purchase_date: okDate(r.purchase_date),
        warranty_end: okDate(r.warranty_end),
        risk: ASSET_RISKS.includes(r.risk) ? r.risk : 'medium',
      });
      for (const [kind, m, d] of [['ppm', r.ppm_months, r.ppm_next], ['calibration', r.cal_months, r.cal_next]]) {
        const months = okMonths(m);
        if (months) plans.push({ tag, kind, every_months: months, next_due: okDate(d) || addMonths(today, 1) });
      }
    }
    const known = new Set((await env.DB.prepare('SELECT tag FROM assets').all()).results.map((r) => r.tag));
    const now = nowIso();
    const stmts = [];
    if (clean.length) {
      const cols = ['tag', 'name_ar', 'name_en', 'type_id', 'department_id', 'location_id', 'manufacturer', 'model', 'serial_no', 'purchase_date', 'warranty_end', 'risk'];
      // One statement for the whole sheet (the free plan counts queries, not rows). Empty cells keep what is there.
      stmts.push(
        env.DB.prepare(
          `INSERT INTO assets (${cols.join(', ')}, created_at, updated_at)
           SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')}, ?2, ?2 FROM json_each(?1) WHERE true
           ON CONFLICT(tag) DO UPDATE SET name_ar = excluded.name_ar, name_en = excluded.name_en, type_id = excluded.type_id,
             ${['department_id', 'location_id', 'manufacturer', 'model', 'serial_no', 'purchase_date', 'warranty_end'].map((c) => `${c} = COALESCE(excluded.${c}, assets.${c})`).join(', ')},
             risk = excluded.risk, updated_at = excluded.updated_at`,
        ).bind(JSON.stringify(clean), now),
      );
    }
    if (plans.length) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO pm_plans (asset_id, kind, every_months, next_due, lead_days, active, created_at)
           SELECT a.id, json_extract(value, '$.kind'), json_extract(value, '$.every_months'), json_extract(value, '$.next_due'), 7, 1, ?2
             FROM json_each(?1) JOIN assets a ON a.tag = json_extract(value, '$.tag') WHERE true
           ON CONFLICT(asset_id, kind) DO UPDATE SET every_months = excluded.every_months, next_due = excluded.next_due, active = 1`,
        ).bind(JSON.stringify(plans), now),
      );
    }
    const added = clean.filter((r) => !known.has(r.tag)).length;
    stmts.push(logStmt(env, user, 'import', 'asset', null, null, { added, updated: clean.length - added, plans: plans.length }));
    await env.DB.batch(stmts);
    return json({ ok: true, added, updated: clean.length - added, plans: plans.length, skipped: rows.length - clean.length });
  }

  if (seg[0] === 'assets' && id !== null) {
    const asset = await env.DB.prepare(ASSET_SELECT + ' WHERE a.id = ?').bind(id).first();
    if (!asset) fail(404, 'not_found');

    // One asset: its plans, the planned jobs done, and every request about it.
    if (method === 'GET' && seg.length === 2) {
      const [{ results: plans }, { results: done }, { results: tickets }, parts] = await Promise.all([
        env.DB.prepare('SELECT p.*, t.status AS ticket_status FROM pm_plans p LEFT JOIN tickets t ON t.id = p.open_ticket_id WHERE p.asset_id = ? ORDER BY p.kind').bind(id).all(),
        env.DB.prepare('SELECT * FROM pm_done WHERE asset_id = ? ORDER BY id DESC LIMIT 100').bind(id).all(),
        env.DB.prepare(
          `SELECT t.id, t.status, t.priority, t.description, t.created_at, t.closed_at, t.resolution, t.pm_plan_id, c.name_ar AS cat_ar, c.name_en AS cat_en
             FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id WHERE t.asset_id = ?1 OR t.asset_tag = ?2 ORDER BY t.id DESC LIMIT 100`,
        ).bind(id, asset.tag).all(),
        // What the spare parts used on it cost: charged to its department, or to a supplier under contract.
        env.DB.prepare("SELECT ROUND(COALESCE(SUM(CASE WHEN covered = 0 THEN -qty * unit_cost END), 0), 2) AS cost, ROUND(COALESCE(SUM(CASE WHEN covered = 1 THEN -qty * unit_cost END), 0), 2) AS covered FROM stock_moves WHERE asset_id = ? AND kind IN ('issue', 'return')").bind(id).first(),
      ]);
      return json({
        asset: assetOut(asset, manager),
        parts_cost: parts,
        contract: await assetContract(env, id, today),
        plans: plans.map((p) => ({ ...p, open_ticket_id: p.ticket_status && p.ticket_status !== 'closed' ? p.open_ticket_id : null })),
        done,
        tickets,
        today,
        can_manage: manager,
      });
    }

    if (method === 'PUT' && seg.length === 2) {
      needManager();
      const next = await readAsset(await readJson(request));
      await tagTaken(next.tag, id);
      await env.DB.batch([
        env.DB.prepare(`UPDATE assets SET ${ASSET_KEYS.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...ASSET_KEYS.map((k) => next[k]), nowIso(), id),
        logStmt(env, user, 'update', 'asset', id, `${next.name_ar} (${next.tag})`, changes(asset, next, ASSET_KEYS)),
      ]);
      return json({ ok: true });
    }

    // An asset with requests stays in the record: it can be retired instead.
    if (method === 'DELETE' && seg.length === 2) {
      needManager();
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickets WHERE asset_id = ?').bind(id).first();
      if (used.n > 0) fail(409, 'asset_has_tickets');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM pm_plans WHERE asset_id = ?').bind(id),
        env.DB.prepare('DELETE FROM pm_done WHERE asset_id = ?').bind(id),
        env.DB.prepare('DELETE FROM contract_assets WHERE asset_id = ?').bind(id),
        env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id),
        logStmt(env, user, 'delete', 'asset', id, `${asset.name_ar} (${asset.tag})`),
      ]);
      return json({ ok: true });
    }

    if (method === 'POST' && seg[2] === 'plans' && seg.length === 3) {
      needManager();
      const next = readPlan(await readJson(request));
      if (await env.DB.prepare('SELECT id FROM pm_plans WHERE asset_id = ? AND kind = ?').bind(id, next.kind).first()) fail(409, 'plan_exists');
      const res = await env.DB.prepare('INSERT INTO pm_plans (asset_id, kind, every_months, next_due, lead_days, checklist, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, next.kind, next.every_months, next.next_due, next.lead_days, next.checklist, next.active, nowIso())
        .run();
      await logStmt(env, user, 'create', 'pm_plan', res.meta.last_row_id, `${asset.name_ar} (${asset.tag})`, { kind: [null, next.kind], every_months: [null, next.every_months] }).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    fail(404, 'not_found');
  }

  if (seg[0] === 'pm-plans' && id !== null && seg.length === 2) {
    needManager();
    const plan = await env.DB.prepare('SELECT p.*, a.name_ar, a.tag FROM pm_plans p JOIN assets a ON a.id = p.asset_id WHERE p.id = ?').bind(id).first();
    if (!plan) fail(404, 'not_found');
    const label = `${plan.name_ar} (${plan.tag})`;
    if (method === 'PUT') {
      // The kind of a plan stays; another kind is another plan.
      const next = readPlan({ ...(await readJson(request)), kind: plan.kind });
      await env.DB.batch([
        env.DB.prepare('UPDATE pm_plans SET every_months = ?, next_due = ?, lead_days = ?, checklist = ?, active = ? WHERE id = ?').bind(next.every_months, next.next_due, next.lead_days, next.checklist, next.active, id),
        logStmt(env, user, 'update', 'pm_plan', id, label, changes(plan, next, ['every_months', 'next_due', 'lead_days', 'checklist', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM pm_plans WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'pm_plan', id, label, { kind: [plan.kind, null] })]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  return null;
}
export const route2 = (method, seg) => `${method} /${seg.join('/')}`;
export function readPlan(body) {
  const next = {
    kind: PM_KINDS.includes(body.kind) ? body.kind : null,
    every_months: toInt(body.every_months),
    next_due: optDate(body.next_due),
    lead_days: toInt(body.lead_days) ?? 7,
    checklist: str(body.checklist, 3000) || null,
    active: body.active === false ? 0 : 1,
  };
  if (!next.kind) fail(400, 'invalid_kind');
  if (!next.every_months || next.every_months < 1 || next.every_months > 120) fail(400, 'invalid_interval');
  if (!next.next_due) fail(400, 'invalid_date');
  if (next.lead_days < 0 || next.lead_days > 90) fail(400, 'invalid_lead');
  return next;
}

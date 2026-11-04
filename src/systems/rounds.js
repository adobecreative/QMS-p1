// Inspection rounds: forms, places, rounds and their reminders.
import { readJson } from '../lib/auth.js';
import { appName } from '../lib/config.js';
import { changes, getSettings, logStmt, setSettingStmt } from '../lib/db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from '../lib/mail.js';
import { ARABIC_RE, diffDays, escHtml, fail, json, nowIso, optDate, sha256Hex, str, todayIn } from '../lib/util.js';
import { route2 } from './assets.js';
import { plusDays } from './docs.js';
import { addMinutes, afterNewTicket, eventStmt, slaFor, ticketPriority, toInt } from './tickets.js';

/* --------------------------------- rounds -------------------------------- */

// Inspection rounds: a checklist walked at set places every few days. A failed line opens one
// request for the checklist's problem type, so the team that fixes it hears about it at once.
export const ROUND_RESULTS = ['ok', 'fail', 'na'];
export const ROUND_TEXT = {
  ar: {
    dir: 'rtl',
    subject: (n, late, app) => `جولات التفتيش المستحقة: ${n}${late ? ` (منها ${late} متأخرة)` : ''} - ${app}`,
    intro: 'الجولات المستحقة اليوم والمتأخرة:',
    cols: ['المكان', 'قائمة الفحص', 'الموعد', 'الحالة'],
    late: (n) => `متأخرة ${n} يوم`,
    today: 'اليوم',
    open: 'فتح الجولات',
    footer: (app) => `رسالة تلقائية من نظام جولات التفتيش - ${app}. يمكن إيقافها من صفحة قوائم الفحص.`,
  },
  en: {
    dir: 'ltr',
    subject: (n, late, app) => `Inspection rounds today: ${n}${late ? `, ${late} late` : ''} - ${app}`,
    intro: 'Rounds due today and late:',
    cols: ['Place', 'Checklist', 'Due', 'Status'],
    late: (n) => `${n} day(s) late`,
    today: 'Today',
    open: 'Open rounds',
    footer: (app) => `Automatic message from Inspection Rounds - ${app}. It can be turned off on the Checklists page.`,
  },
};
export function buildRoundDigest(places, today, settings) {
  const L = ROUND_TEXT[settings.email_lang === 'en' ? 'en' : 'ar'];
  const en = settings.email_lang === 'en';
  const app = appName(settings, settings.email_lang);
  const align = L.dir === 'rtl' ? 'right' : 'left';
  const cell = `padding:8px 10px;border-bottom:1px solid #f1eadb;text-align:${align};font-size:14px`;
  const rows = places
    .map((p) => {
      const late = diffDays(today, p.next_due);
      return `<tr><td style="${cell};font-weight:bold">${escHtml(en ? p.loc_en : p.loc_ar)}</td><td style="${cell}">${escHtml(en ? p.name_en : p.name_ar)}</td><td style="${cell}" dir="ltr">${escHtml(p.next_due)}</td><td style="${cell};font-weight:bold;color:${late > 0 ? '#7d2f27' : '#5f4a10'}">${escHtml(late > 0 ? L.late(late) : L.today)}</td></tr>`;
    })
    .join('');
  const head = L.cols.map((c) => `<th style="${cell};background:#faf7f0;font-size:13px">${escHtml(c)}</th>`).join('');
  const link = settings.site_url ? `<p style="margin:18px 0"><a href="${escHtml(settings.site_url + '/#/rounds/due')}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>` : '';
  const late = places.filter((p) => p.next_due < today).length;
  const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(settings)}<p style="font-size:15px">${escHtml(L.intro)}</p><table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${link}<p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
  return { subject: L.subject(places.length, late, app), html };
}

// Every morning: inspectors and rounds managers get the rounds due today and the late ones.
// System admins get nothing. force = sent from the page, even if already sent today or switched off.
export async function runRoundReminders(env, actor, force) {
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);
  if (!force && (settings.round_reminders !== '1' || settings.round_reminded_on === today)) return { ok: true, skipped: true, places: 0, emails: 0 };
  const { results: places } = await env.DB.prepare(
    `SELECT p.id, p.next_due, f.name_ar, f.name_en, l.name_ar AS loc_ar, l.name_en AS loc_en
       FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1
       JOIN locations l ON l.id = p.location_id AND l.active = 1
      WHERE p.next_due <= ? ORDER BY p.next_due, l.name_ar LIMIT 300`,
  ).bind(today).all();
  if (!places.length) return { ok: true, places: 0, emails: 0 };
  if (!mailReady(settings)) return { ok: false, error: 'mail_not_configured', places: places.length, emails: 0 };
  const { results: people } = await env.DB.prepare(
    "SELECT email FROM users WHERE active = 1 AND role NOT IN ('super_admin', 'systems_admin') AND rounds_role IN ('inspector', 'manager')",
  ).all();
  const messages = people.map((u) => ({ to: u.email, ...bothLangs(settings, (s) => buildRoundDigest(places, today, s)) }));
  if (!messages.length) return { ok: true, places: places.length, emails: 0 };
  const result = await sendMail(settings, messages);
  if (!result.ok) {
    await logStmt(env, actor, 'remind_failed', 'round', null, null, { error: result.error, places: places.length }).run();
    return { ok: false, error: result.error, places: places.length, emails: result.sent || 0 };
  }
  await env.DB.batch([setSettingStmt(env, 'round_reminded_on', today), logStmt(env, actor, 'remind', 'round', null, null, { places: places.length, emails: messages.length })]);
  return { ok: true, places: places.length, emails: messages.length };
}
export const ROUND_ITEMS_MAX = 60;
export const ROUND_PLACES_MAX = 300;

export async function handleRounds(request, env, url, seg, method, user, ctx) {
  const role = user.rounds;
  if (!role || role === 'none') fail(403, 'forbidden');
  const manager = role === 'admin' || role === 'manager';
  const needManager = () => {
    if (!manager) fail(403, 'forbidden');
  };
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  const settings = await getSettings(env);
  const today = todayIn(settings.timezone);

  // Checklists (managers): name, how often, the problem type a failed line goes to, its lines and places.
  if (seg[0] === 'round-forms') {
    needManager();
    if (route2(method, seg) === 'GET /round-forms') {
      const [{ results: forms }, { results: locations }, { results: categories }] = await Promise.all([
        env.DB.prepare(
          `SELECT f.*, c.name_ar AS cat_ar, c.name_en AS cat_en,
                  (SELECT COUNT(*) FROM round_items i WHERE i.form_id = f.id) AS item_count,
                  (SELECT COUNT(*) FROM round_places p WHERE p.form_id = f.id) AS place_count,
                  (SELECT COUNT(*) FROM rounds r WHERE r.form_id = f.id) AS round_count
             FROM round_forms f LEFT JOIN ticket_categories c ON c.id = f.category_id ORDER BY f.name_ar`,
        ).all(),
        env.DB.prepare('SELECT id, name_ar, name_en, department_id FROM locations WHERE active = 1 ORDER BY name_ar').all(),
        env.DB.prepare(
          `SELECT c.id, c.name_ar, c.name_en, d.name_ar AS team_ar, d.name_en AS team_en FROM ticket_categories c
             LEFT JOIN departments d ON d.id = c.team_id WHERE c.active = 1 AND COALESCE(c.pm, 0) = 0 ORDER BY d.name_ar, c.name_ar`,
        ).all(),
      ]);
      return json({ forms, locations, categories, today, reminders: settings.round_reminders === '1', require_scan: settings.round_require_scan === '1', reminded_on: settings.round_reminded_on || null, mail_ready: mailReady(settings) });
    }
    // The morning email: switch it on or off, or send it now.
    if (route2(method, seg) === 'PUT /round-forms/reminders') {
      const body = await readJson(request);
      const on = body.on === false ? '0' : '1';
      await env.DB.batch([setSettingStmt(env, 'round_reminders', on), logStmt(env, user, 'update', 'settings', null, null, { round_reminders: [settings.round_reminders, on] })]);
      return json({ ok: true });
    }
    if (route2(method, seg) === 'POST /round-forms/reminders') return json(await runRoundReminders(env, user, true));
    if (route2(method, seg) === 'PUT /round-forms/require-scan') {
      const body = await readJson(request);
      const on = body.on ? '1' : '0';
      await env.DB.batch([setSettingStmt(env, 'round_require_scan', on), logStmt(env, user, 'update', 'settings', null, null, { round_require_scan: [settings.round_require_scan, on] })]);
      return json({ ok: true });
    }
    const readForm = async () => {
      const body = await readJson(request);
      const items = (Array.isArray(body.items) ? body.items : [])
        .map((x) => ({ a: str(x && x.text_ar, 300), e: str(x && x.text_en, 300) || null }))
        .filter((x) => x.a);
      if (items.some((x) => x.e && ARABIC_RE.test(x.e))) fail(400, 'field_arabic');
      const next = {
        name_ar: str(body.name_ar, 150),
        name_en: str(body.name_en, 150),
        every_days: toInt(body.every_days),
        category_id: toInt(body.category_id),
        active: body.active === false ? 0 : 1,
        first_due: optDate(body.first_due) || today,
        items,
        location_ids: [...new Set((Array.isArray(body.location_ids) ? body.location_ids : []).map(toInt).filter(Boolean))],
      };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      if (!next.every_days || next.every_days < 1 || next.every_days > 366) fail(400, 'every_days_bad');
      if (!items.length) fail(400, 'items_required');
      if (items.length > ROUND_ITEMS_MAX || next.location_ids.length > ROUND_PLACES_MAX) fail(400, 'too_many');
      if (!next.location_ids.length) fail(400, 'places_required');
      if (!next.category_id || !(await env.DB.prepare('SELECT id FROM ticket_categories WHERE id = ? AND COALESCE(pm, 0) = 0').bind(next.category_id).first())) fail(400, 'category_required');
      const known = await env.DB.prepare('SELECT COUNT(*) AS n FROM locations WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(next.location_ids)).first();
      if (known.n !== next.location_ids.length) fail(400, 'location_required');
      return next;
    };
    const itemsStmt = (formId, items) =>
      env.DB.prepare("INSERT INTO round_items (form_id, sort, text_ar, text_en) SELECT ?1, key, json_extract(value, '$.a'), json_extract(value, '$.e') FROM json_each(?2)").bind(formId, JSON.stringify(items));
    const placesStmt = (formId, ids, due) =>
      env.DB.prepare('INSERT OR IGNORE INTO round_places (form_id, location_id, next_due) SELECT ?1, value, ?2 FROM json_each(?3)').bind(formId, due, JSON.stringify(ids));

    if (method === 'POST' && seg.length === 1) {
      const next = await readForm();
      const now = nowIso();
      const res = await env.DB.prepare('INSERT INTO round_forms (name_ar, name_en, every_days, category_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(next.name_ar, next.name_en, next.every_days, next.category_id, next.active, now, now)
        .run();
      const formId = res.meta.last_row_id;
      await env.DB.batch([
        itemsStmt(formId, next.items),
        placesStmt(formId, next.location_ids, next.first_due),
        logStmt(env, user, 'create', 'round_form', formId, next.name_ar, { items: next.items.length, places: next.location_ids.length }),
      ]);
      return json({ ok: true, id: formId });
    }
    const form = id !== null ? await env.DB.prepare('SELECT * FROM round_forms WHERE id = ?').bind(id).first() : null;
    if (!form) fail(404, 'not_found');
    if (method === 'GET' && seg.length === 2) {
      const [{ results: items }, { results: places }] = await Promise.all([
        env.DB.prepare('SELECT id, sort, text_ar, text_en FROM round_items WHERE form_id = ? ORDER BY sort, id').bind(id).all(),
        env.DB.prepare('SELECT id, location_id, next_due, last_done FROM round_places WHERE form_id = ?').bind(id).all(),
      ]);
      return json({ form, items, places });
    }
    if (method === 'PUT' && seg.length === 2) {
      const next = await readForm();
      // The lines are written again (past rounds keep their own copy); places keep their dates, new ones start on first_due.
      await env.DB.batch([
        env.DB.prepare('UPDATE round_forms SET name_ar = ?, name_en = ?, every_days = ?, category_id = ?, active = ?, updated_at = ? WHERE id = ?').bind(
          next.name_ar, next.name_en, next.every_days, next.category_id, next.active, nowIso(), id),
        env.DB.prepare('DELETE FROM round_items WHERE form_id = ?').bind(id),
        itemsStmt(id, next.items),
        env.DB.prepare('DELETE FROM round_places WHERE form_id = ?1 AND location_id NOT IN (SELECT value FROM json_each(?2))').bind(id, JSON.stringify(next.location_ids)),
        placesStmt(id, next.location_ids, next.first_due),
        logStmt(env, user, 'update', 'round_form', id, next.name_ar, changes(form, next, ['name_ar', 'name_en', 'every_days', 'category_id', 'active'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg.length === 2) {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM rounds WHERE form_id = ?').bind(id).first();
      if (used.n > 0) fail(409, 'form_has_rounds');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM round_items WHERE form_id = ?').bind(id),
        env.DB.prepare('DELETE FROM round_places WHERE form_id = ?').bind(id),
        env.DB.prepare('DELETE FROM round_forms WHERE id = ?').bind(id),
        logStmt(env, user, 'delete', 'round_form', id, form.name_ar),
      ]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  // Every place of every active checklist with its next date, and how well rounds kept to time (90 days).
  if (route2(method, seg) === 'GET /rounds') {
    const [{ results: places }, stats] = await Promise.all([
      env.DB.prepare(
        `SELECT p.id, p.form_id, p.location_id, p.next_due, p.last_done, f.name_ar, f.name_en, f.every_days,
                l.name_ar AS loc_ar, l.name_en AS loc_en, d.name_ar AS dept_ar, d.name_en AS dept_en
           FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1
           JOIN locations l ON l.id = p.location_id AND l.active = 1
           LEFT JOIN departments d ON d.id = l.department_id
          ORDER BY p.next_due, l.name_ar LIMIT 3000`,
      ).all(),
      env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(on_time), 0) AS ok, COALESCE(SUM(fail_n > 0), 0) AS with_fail, COALESCE(SUM(scanned), 0) AS scanned FROM rounds WHERE done_on >= ?').bind(plusDays(today, -90)).first(),
    ]);
    return json({ places, stats, today, can_manage: manager });
  }

  // A place's QR code scanned: its rounds, so the inspector starts the right one.
  if (method === 'GET' && seg[1] === 'scan' && seg.length === 3) {
    const loc = await env.DB.prepare('SELECT id, name_ar, name_en FROM locations WHERE code = ? AND active = 1').bind(str(seg[2], 40)).first();
    if (!loc) fail(404, 'bad_location');
    const { results: places } = await env.DB.prepare(
      `SELECT p.id, p.next_due, p.last_done, f.name_ar, f.name_en FROM round_places p JOIN round_forms f ON f.id = p.form_id AND f.active = 1
        WHERE p.location_id = ? ORDER BY p.next_due`,
    ).bind(loc.id).all();
    return json({ location: loc, places, today });
  }

  // The checklist for one place, to walk it.
  if (method === 'GET' && seg[1] === 'start' && /^\d+$/.test(seg[2] || '') && seg.length === 3) {
    const place = await env.DB.prepare(
      `SELECT p.id, p.form_id, p.location_id, p.next_due, p.last_done, f.name_ar, f.name_en, f.every_days, f.active,
              l.name_ar AS loc_ar, l.name_en AS loc_en
         FROM round_places p JOIN round_forms f ON f.id = p.form_id JOIN locations l ON l.id = p.location_id WHERE p.id = ?`,
    ).bind(Number(seg[2])).first();
    if (!place || !place.active) fail(404, 'not_found');
    const { results: items } = await env.DB.prepare('SELECT id, text_ar, text_en FROM round_items WHERE form_id = ? ORDER BY sort, id').bind(place.form_id).all();
    return json({ place, items, today, require_scan: settings.round_require_scan === '1' });
  }

  // A round done: every line answered. Failed lines become one request; the place moves to its next date.
  if (route2(method, seg) === 'POST /rounds') {
    const body = await readJson(request);
    const placeId = toInt(body.place_id);
    const place = placeId
      ? await env.DB.prepare(
          `SELECT p.*, f.name_ar, f.name_en, f.every_days, f.category_id, f.active, l.name_ar AS loc_ar, l.name_en AS loc_en, l.department_id
             FROM round_places p JOIN round_forms f ON f.id = p.form_id JOIN locations l ON l.id = p.location_id WHERE p.id = ?`,
        ).bind(placeId).first()
      : null;
    if (!place || !place.active) fail(404, 'not_found');
    const { results: items } = await env.DB.prepare('SELECT id, text_ar, text_en FROM round_items WHERE form_id = ? ORDER BY sort, id').bind(place.form_id).all();
    const given = new Map((Array.isArray(body.answers) ? body.answers : []).map((a) => [toInt(a && a.item_id), a]));
    const answers = items.map((it) => {
      const a = given.get(it.id);
      if (!a || !ROUND_RESULTS.includes(a.result)) fail(400, 'answers_required');
      return { a: it.text_ar, e: it.text_en, r: a.result, n: str(a.note, 500) || null };
    });
    const count = (r) => answers.filter((x) => x.r === r).length;
    const failed = answers.filter((x) => x.r === 'fail');
    const note = str(body.note, 1000) || null;
    const code = str(body.loc_code, 40);
    const scanned = code ? !!(await env.DB.prepare('SELECT id FROM locations WHERE id = ? AND code = ?').bind(place.location_id, code).first()) : false;
    if (settings.round_require_scan === '1' && !scanned) fail(403, 'scan_required');
    const now = nowIso();
    const onTime = today <= place.next_due ? 1 : 0;
    // A second round in the same period is kept but does not push the date on again; a late one counts from today.
    const again = place.last_done && place.last_done >= plusDays(place.next_due, -place.every_days);
    const nextDue = again ? place.next_due : plusDays(onTime ? place.next_due : today, place.every_days);

    const res = await env.DB.prepare(
      `INSERT INTO rounds (form_id, place_id, location_id, user_id, user_name, done_at, done_on, due, on_time, ok_n, fail_n, na_n, note, scanned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(place.form_id, place.id, place.location_id, user.id, user.name, now, today, place.next_due, onTime, count('ok'), failed.length, count('na'), note, scanned ? 1 : 0).run();
    const roundId = res.meta.last_row_id;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO round_answers (round_id, text_ar, text_en, result, note) SELECT ?1, json_extract(value, '$.a'), json_extract(value, '$.e'), json_extract(value, '$.r'), json_extract(value, '$.n') FROM json_each(?2)",
      ).bind(roundId, JSON.stringify(answers)),
      env.DB.prepare('UPDATE round_places SET last_done = ?, next_due = ? WHERE id = ?').bind(today, nextDue, place.id),
    ]);

    let ticketId = null;
    const cat = failed.length ? await env.DB.prepare('SELECT id, team_id, priority FROM ticket_categories WHERE id = ?').bind(place.category_id).first() : null;
    if (cat) {
      const priority = ticketPriority(cat.priority, 0);
      const sla = slaFor(settings, priority);
      const description = [
        `جولة تفتيش: ${place.name_ar} - ${place.loc_ar}`,
        `Inspection round: ${place.name_en} - ${place.loc_en}`,
        '',
        ...failed.map((x) => `- ${x.a}${x.e ? ` / ${x.e}` : ''}${x.n ? `: ${x.n}` : ''}`),
        ...(note ? ['', note] : []),
      ].join('\n');
      const t = await env.DB.prepare(
        `INSERT INTO tickets (status, priority, patient_impact, category_id, team_id, requester_emp_no, requester_name, requester_dept_id, location_id,
                              description, response_due, resolve_due, track_hash, created_at, updated_at)
         VALUES ('new', ?, 0, ?, ?, '-', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(priority, cat.id, cat.team_id, user.name, place.department_id, place.location_id, description, addMinutes(now, sla.resp), addMinutes(now, sla.res), await sha256Hex(crypto.randomUUID()), now, now).run();
      ticketId = t.meta.last_row_id;
      await env.DB.batch([
        eventStmt(env, ticketId, user, 'created', null, { round: roundId }),
        env.DB.prepare('UPDATE rounds SET ticket_id = ? WHERE id = ?').bind(ticketId, roundId),
      ]);
      ctx.waitUntil(afterNewTicket(env, 'new', ticketId));
    }
    return json({ ok: true, id: roundId, scanned, ticket_id: ticketId, ok_n: count('ok'), fail_n: failed.length, na_n: count('na'), next_due: nextDue });
  }

  // Rounds done, newest first, with an optional date range and checklist.
  if (route2(method, seg) === 'GET /rounds/log') {
    const from = optDate(url.searchParams.get('from')) || plusDays(today, -30);
    const to = optDate(url.searchParams.get('to')) || today;
    const formId = toInt(url.searchParams.get('form'));
    const binds = [from, to];
    const { results: rows } = await env.DB.prepare(
      `SELECT r.id, r.form_id, r.done_at, r.done_on, r.due, r.on_time, r.ok_n, r.fail_n, r.na_n, r.user_name, r.ticket_id, r.scanned,
              f.name_ar, f.name_en, l.name_ar AS loc_ar, l.name_en AS loc_en
         FROM rounds r JOIN round_forms f ON f.id = r.form_id LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.done_on >= ?1 AND r.done_on <= ?2 ${formId ? `AND r.form_id = ?${binds.push(formId)}` : ''}
        ORDER BY r.done_at DESC LIMIT 1000`,
    ).bind(...binds).all();
    const { results: forms } = await env.DB.prepare('SELECT id, name_ar, name_en FROM round_forms ORDER BY name_ar').all();
    return json({ rounds: rows, forms, from, to });
  }

  if (method === 'GET' && id !== null && seg.length === 2) {
    const round = await env.DB.prepare(
      `SELECT r.*, f.name_ar, f.name_en, l.name_ar AS loc_ar, l.name_en AS loc_en, t.status AS ticket_status
         FROM rounds r JOIN round_forms f ON f.id = r.form_id LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN tickets t ON t.id = r.ticket_id WHERE r.id = ?`,
    ).bind(id).first();
    if (!round) fail(404, 'not_found');
    const { results: answers } = await env.DB.prepare('SELECT text_ar, text_en, result, note FROM round_answers WHERE round_id = ? ORDER BY id').bind(id).all();
    return json({ round, answers });
  }
  return null;
}

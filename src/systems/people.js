// Accounts and roles set from the Fikra portal's "Users & permissions" screen (keys with the "Fikra portal" scope).
// The portal lists who has an account here and with which roles, and sets them one person at a time, by email.
// The system owner's account is never changed from outside, and the portal alone decides who is a super admin.
import { hashPassword } from '../lib/auth.js';
import { ADMIN_ROLES, DOCS_ROLES, MEETINGS_ROLES, QUALITY_ROLES, ROLES, ROUNDS_ROLES } from '../lib/config.js';
import { changes, logStmt } from '../lib/db.js';
import { licenseState } from '../lib/license.js';
import { fail, json, nowIso, str, toHex } from '../lib/util.js';

// The parts of this system a person can be given, with their names, so the portal shows them as they are here.
const opt = (v, ar, en) => ({ v, ar, en });
const NONE = opt('none', 'بدون دخول', 'No access');
export const PEOPLE_APPS = [
  { key: 'quality_role', ar: 'الجودة والاعتماد', en: 'Quality & Accreditation', values: QUALITY_ROLES, options: [NONE, opt('viewer', 'اطلاع', 'Viewer'), opt('assessor', 'مُقيِّم', 'Assessor'), opt('manager', 'مدير الجودة', 'Quality manager')] },
  { key: 'meetings_role', ar: 'اللجان والاجتماعات', en: 'Committees & Meetings', values: MEETINGS_ROLES, options: [NONE, opt('viewer', 'اطلاع', 'Viewer'), opt('secretary', 'أمين لجنة', 'Committee secretary'), opt('manager', 'مدير اللجان', 'Committees manager')] },
  { key: 'rounds_role', ar: 'جولات الجودة', en: 'Quality rounds', values: ROUNDS_ROLES, options: [NONE, opt('inspector', 'مفتش', 'Inspector'), opt('manager', 'مدير الجولات', 'Rounds manager')] },
  { key: 'docs_role', ar: 'إدارة الوثائق', en: 'Document Control', values: DOCS_ROLES, options: [NONE, opt('viewer', 'قارئ', 'Viewer'), opt('dept_admin', 'مسؤول وثائق القسم', 'Department documents admin')] },
];
const ROLE_KEYS = PEOPLE_APPS.map((a) => a.key);

const ownerIdOf = async (env) => (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
const personOut = (u, ownerId) => ({
  email: u.email,
  active: !!u.active,
  owner: u.id === ownerId,
  role: u.role,
  roles: Object.fromEntries(ROLE_KEYS.map((k) => [k, u[k] || 'none'])),
});

export async function handlePeople(request, env, url, method, actor) {
  const ownerId = await ownerIdOf(env);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY id').all();
    return json({ apps: PEOPLE_APPS.map(({ key, ar, en, options }) => ({ key, ar, en, options })), people: results.map((u) => personOut(u, ownerId)) });
  }
  if (method !== 'PUT') fail(405, 'method_not_allowed');
  let body;
  try {
    body = await request.json();
  } catch {
    fail(400, 'invalid_json');
  }
  // Logged under the portal admin who made the change.
  const by = str(body.by, 100);
  if (by) actor = { id: null, name: `${actor.name} (${by})` };
  const email = str(body.email, 200).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email');
  const old = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (old && old.id === ownerId) fail(403, 'owner_account');
  const account = body.account !== false;

  // No account here: switched off (kept, so its history keeps its name).
  if (!account) {
    if (old && old.active) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(old.id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(old.id),
        logStmt(env, actor, 'update', 'user', old.id, old.name, { active: [1, 0] }),
      ]);
    }
    return json({ ok: true, person: old ? personOut({ ...old, active: 0 }, ownerId) : null });
  }

  const role = ROLES.includes(body.role) ? body.role : 'user';
  const admin = ADMIN_ROLES.includes(role);
  const roles = {};
  for (const a of PEOPLE_APPS) roles[a.key] = !admin && a.values.includes(body.roles && body.roles[a.key]) ? body.roles[a.key] : 'none';
  // The person's department, matched by its Arabic name (each system keeps its own list).
  const deptName = str(body.department_ar, 100);
  const dept = deptName && !admin ? await env.DB.prepare('SELECT id FROM departments WHERE name_ar = ?').bind(deptName).first() : null;
  const department_id = dept ? dept.id : null;
  if (roles.docs_role === 'dept_admin' && !department_id) fail(400, 'department_required');
  // Their mobile number and names follow the portal (an empty one there leaves the one here as it is).
  const phoneIn = str(body.phone, 30);
  const phone = /^\+?[0-9 -]{5,30}$/.test(phoneIn) ? phoneIn : null;

  if (old) {
    const next = { role, ...roles, department_id, active: 1, phone: phone || old.phone || null, name: str(body.name, 100) || old.name, name_en: str(body.name_en, 100) || old.name_en };
    const diff = changes(old, next, ['name', 'name_en', 'phone', 'role', ...ROLE_KEYS, 'department_id', 'active']);
    if (!old.active) {
      const lic = (await licenseState(env, url.hostname)).lic;
      const max = lic ? Number(lic.max_users) || 0 : 0;
      if (max && (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first()).n >= max) fail(409, 'license_user_limit');
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET name = ?, name_en = ?, phone = ?, role = ?, ${ROLE_KEYS.map((k) => k + ' = ?').join(', ')}, department_id = ?, active = 1 WHERE id = ?`).bind(next.name, next.name_en, next.phone, role, ...ROLE_KEYS.map((k) => roles[k]), department_id, old.id),
      ...(Object.keys(diff).length ? [logStmt(env, actor, 'update', 'user', old.id, old.name, diff)] : []),
    ]);
    return json({ ok: true, person: personOut({ ...old, ...next }, ownerId) });
  }

  // A new account: no password of its own, the person comes in from the portal (or sets one with "forgot password").
  const name = str(body.name, 100) || email;
  const name_en = str(body.name_en, 100) || name;
  const lic = (await licenseState(env, url.hostname)).lic;
  const max = lic ? Number(lic.max_users) || 0 : 0;
  if (max && (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first()).n >= max) fail(409, 'license_user_limit');
  const pid = Number(body.portal_id);
  const portalId = Number.isInteger(pid) && (await env.DB.prepare('SELECT id FROM portal_users WHERE id = ?').bind(pid).first()) && !(await env.DB.prepare('SELECT id FROM users WHERE portal_id = ?').bind(pid).first()) ? pid : null;
  const hash = await hashPassword(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const res = await env.DB.prepare(
    `INSERT INTO users (name, name_en, email, phone, password_hash, role, ${ROLE_KEYS.join(', ')}, department_id, active, portal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ${ROLE_KEYS.map(() => '?').join(', ')}, ?, 1, ?, ?)`,
  )
    .bind(name, name_en, email, phone, hash, role, ...ROLE_KEYS.map((k) => roles[k]), department_id, portalId, nowIso())
    .run();
  await logStmt(env, actor, 'create', 'user', res.meta.last_row_id, name, { role: [null, role], ...Object.fromEntries(ROLE_KEYS.map((k) => [k, [null, roles[k]]])) }).run();
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ ok: true, person: personOut(row, ownerId) });
}

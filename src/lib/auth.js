// Passwords, sessions, two-step sign-in and who may do what.
import { ASSETS_ROLES, DESK_ROLES, DOCS_ROLES, LOCK_MINUTES, MAX_FAILED_LOGINS, PBKDF2_ITERATIONS, RECOVERY_COUNT, MEETINGS_ROLES, QUALITY_ROLES, ROUNDS_ROLES, SESSION_DAYS, TOTP_PERIOD, isAdmin } from './config.js';
import { logStmt } from './db.js';
import { HttpError, b64d, b64e, checkLang, fail, nowIso, safeEqual, sha256Hex, str, toHex } from './util.js';

/* ------------------------------ auth helpers ----------------------------- */

export async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? b64d(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${b64e(salt)}$${b64e(new Uint8Array(bits))}`;
}
export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const again = await hashPassword(password, parts[2], Number(parts[1]));
  return safeEqual(again, stored);
}
export const checkPassword = (p) => {
  if (typeof p !== 'string' || p.length < 8 || p.length > 200) fail(400, 'weak_password');
  return p;
};
export const checkEmail = (v) => {
  const email = str(v, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email');
  return email;
};

export const sessionCookie = (token, maxAge) => `fm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

export async function createSession(env, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(token), userId, expires),
  ]);
  return token;
}

export async function getUser(request, env) {
  const token = readCookie(request, 'fm_session');
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.name_en, u.email, u.role, u.docs_role, u.desk_role, u.assets_role, u.rounds_role, u.quality_role, u.meetings_role, u.department_id, u.job_title, u.totp_on, s.token_hash,
            (SELECT value FROM settings WHERE key = 'require_2fa') AS require_2fa
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first();
  if (!row) return null;
  withAccess(row);
  // Until a required second step is set up, the account can only set it up (or sign out).
  row.must_2fa = !row.totp_on && needs2fa(row, row.require_2fa);
  return row;
}

export const isManagerRole = (u) => isAdmin(u) || u.docs_role === 'dept_admin' || u.desk_role === 'supervisor' || u.assets_role === 'manager' || u.rounds_role === 'manager' || u.quality_role === 'manager' || u.meetings_role === 'manager';
export const needs2fa = (u, level) => (level === 'super' ? isAdmin(u) : level === 'managers' ? isManagerRole(u) : false);

/* two-step sign-in (TOTP) */

export const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32e(bytes) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of bytes) {
    val = ((val << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function b32d(text) {
  let bits = 0;
  let val = 0;
  const out = [];
  for (const c of text) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    val = ((val << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
export async function totpAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', b32d(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  let x = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = x & 255;
    x = Math.floor(x / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = mac[19] & 15;
  const n = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
// The step the code belongs to (one step either side, for clocks a little off), or 0. Steps at or
// before the last one used are refused, so a code seen over someone's shoulder cannot be used again.
export async function totpCheck(secret, code, lastStep) {
  if (!secret || !/^\d{6}$/.test(code)) return 0;
  const now = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  for (const step of [now - 1, now, now + 1]) if (step > lastStep && safeEqual(await totpAt(secret, step), code)) return step;
  return 0;
}
export const RECOVERY_RE = /^[A-Z2-9]{10}$/;
export const cleanRecovery = (v) => str(v, 40).toUpperCase().replace(/[^A-Z0-9]/g, '');
// 10 codes of 10 letters and digits (no 0, 1, O or I, which are easily confused), shown once, kept as hashes.
export async function newRecoveryCodes(env, userId) {
  const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = Array.from({ length: RECOVERY_COUNT }, () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => ABC[b & 31]).join(''));
  const hashes = await Promise.all(codes.map((c) => sha256Hex('rc:' + c)));
  return {
    codes: codes.map((c) => c.slice(0, 5) + '-' + c.slice(5)),
    stmts: [
      env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
      env.DB.prepare('INSERT INTO recovery_codes (user_id, code_hash) SELECT ?1, value FROM json_each(?2)').bind(userId, JSON.stringify(hashes)),
    ],
  };
}
// Where a sign-in came from, for the activity log.
export const loginFrom = (request) => ({ ip: str(request.headers.get('CF-Connecting-IP') || '', 60) || null, country: (request.cf && request.cf.country) || null });
// A wrong password or code: counted on the account in one statement, and locked at the limit.
export async function failedLogin(env, request, u, step) {
  const row = await env.DB.prepare(
    `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= ?1 THEN 0 ELSE failed_logins + 1 END,
                      locked_until = CASE WHEN failed_logins + 1 >= ?1 THEN ?2 ELSE locked_until END
      WHERE id = ?3 RETURNING locked_until`,
  )
    .bind(MAX_FAILED_LOGINS, new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), u.id)
    .first();
  const locked = row && row.locked_until && row.locked_until > nowIso();
  await logStmt(env, { id: u.id, name: u.name }, locked ? 'login_locked' : 'login_failed', 'user', u.id, u.name, { ...loginFrom(request), step }).run();
}

// What the person can do in each system: a super admin is admin everywhere.
export function withAccess(u) {
  const sup = isAdmin(u);
  u.docs = sup ? 'admin' : DOCS_ROLES.includes(u.docs_role) ? u.docs_role : 'none';
  u.desk = sup ? 'admin' : DESK_ROLES.includes(u.desk_role) ? u.desk_role : 'none';
  u.assets = sup ? 'admin' : ASSETS_ROLES.includes(u.assets_role) ? u.assets_role : 'none';
  u.rounds = sup ? 'admin' : ROUNDS_ROLES.includes(u.rounds_role) ? u.rounds_role : 'none';
  u.quality = sup ? 'admin' : QUALITY_ROLES.includes(u.quality_role) ? u.quality_role : 'none';
  u.meetings = sup ? 'admin' : MEETINGS_ROLES.includes(u.meetings_role) ? u.meetings_role : 'none';
  return u;
}

export const userOut = (u) => ({
  id: u.id,
  name: u.name,
  name_en: u.name_en || u.name,
  email: u.email,
  role: u.role,
  docs_role: u.docs_role || 'none',
  desk_role: u.desk_role || 'none',
  assets_role: u.assets_role || 'none',
  rounds_role: u.rounds_role || 'none',
  quality_role: u.quality_role || 'none',
  meetings_role: u.meetings_role || 'none',
  ...(u.docs ? { docs: u.docs, desk: u.desk, assets: u.assets, rounds: u.rounds, quality: u.quality, meetings: u.meetings } : {}),
  department_id: u.department_id ?? null,
  job_title: u.job_title || '',
  totp_on: !!u.totp_on,
  ...(u.must_2fa ? { must_2fa: true } : {}),
  active: u.active === undefined ? true : !!u.active,
  created_at: u.created_at,
});

export const requireRole = (user, ...roles) => {
  if (!roles.includes(user.role)) fail(403, 'forbidden');
};
// Document Control: department admins only ever see and manage their own department.
export const requireDocs = (user, ...roles) => {
  if (user.docs === 'none' || (roles.length && !roles.includes(user.docs))) fail(403, 'forbidden');
};
export const canSeeDept = (user, deptId) => user.docs !== 'dept_admin' || user.department_id === deptId;
export const canEditDept = (user, deptId) => user.docs === 'admin' || (user.docs === 'dept_admin' && user.department_id === deptId);

// Browsers send Origin on state-changing requests; reject anything coming from another site.
export function checkOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    fail(403, 'bad_origin');
  }
  if (host !== url.host) fail(403, 'bad_origin');
}

export const readJson = async (request) => {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') fail(400, 'bad_request');
    checkLang((k) => body[k]);
    return body;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(400, 'bad_request');
  }
};

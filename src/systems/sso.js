// Signing in from the Fikra portal. The portal sends the browser here with a one-minute token, signed with the
// link key this system made for it (a key with the "Fikra portal" scope). The token names the person by email:
// they need an active account here, and their roles here stay as they are set here. Each token works once.
import { createSession, loginFrom, sessionCookie, userOut, withAccess } from '../lib/auth.js';
import { CHALLENGE_MINUTES, SESSION_DAYS } from '../lib/config.js';
import { getSettings, logStmt } from '../lib/db.js';
import { invAccess } from './inv.js';
import { riskAccess } from './risk.js';
import { pexAccess } from './pex.js';
import { fail, json, nowIso, sha256Hex, toHex } from '../lib/util.js';

const SSO_AHEAD_S = 120; // a token is never good for longer than this, whatever it says
const enc = new TextEncoder();

function fromB64url(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0)));
}

// The portal holds the key itself; this system keeps only its hash, so the hash is the shared secret.
async function sign(keyHash, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(keyHash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))));
}
const sameText = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

export async function portalSignIn(request, env, url, token) {
  const m = /^([A-Za-z0-9_-]{20,800})\.([0-9a-f]{64})$/.exec(typeof token === 'string' ? token : '');
  if (!m) fail(400, 'sso_invalid');
  let p = null;
  try {
    p = JSON.parse(fromB64url(m[1]));
  } catch {
    fail(400, 'sso_invalid');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!p || typeof p.e !== 'string' || !/^[0-9a-f]{32}$/.test(String(p.n)) || typeof p.x !== 'number' || p.a !== url.origin) fail(401, 'sso_invalid');
  if (p.x < now || p.x > now + SSO_AHEAD_S) fail(401, 'sso_expired');

  const { results } = await env.DB.prepare('SELECT id, key_hash, scopes FROM api_keys WHERE active = 1').all();
  let key = null;
  for (const k of results) {
    if (k.scopes.split(',').includes('portal') && sameText(await sign(k.key_hash, m[1]), m[2])) {
      key = k;
      break;
    }
  }
  if (!key) fail(401, 'sso_invalid');

  // Taken in one statement, so the same link opened twice signs in only once.
  const took = await env.DB.prepare('INSERT OR IGNORE INTO sso_used (nonce, expires_at) VALUES (?, ?)').bind(p.n, new Date((p.x + 60) * 1000).toISOString()).run();
  if (!took.meta.changes) fail(401, 'sso_expired');
  await env.DB.prepare('DELETE FROM sso_used WHERE expires_at < ?').bind(nowIso()).run();

  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(p.e.trim().toLowerCase().slice(0, 200)).first();
  if (!u) fail(403, 'sso_no_account');
  if (u.locked_until && u.locked_until > nowIso()) fail(429, 'account_locked');

  // Two-step sign-in on here: the portal counts as the password, the code is still asked for.
  if (u.totp_on) {
    const ticket = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_challenges WHERE expires_at < ? OR user_id = ?').bind(nowIso(), u.id),
      env.DB.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(ticket), u.id, new Date(Date.now() + CHALLENGE_MINUTES * 60000).toISOString()),
    ]);
    return json({ ok: true, need_code: true, ticket });
  }
  await logStmt(env, { id: u.id, name: u.name }, 'login', 'user', u.id, u.name, { ...loginFrom(request), method: 'portal' }).run();
  const session = await createSession(env, u.id);
  return json({ ok: true, user: { ...userOut(withAccess(u)), inv: await invAccess(env, u, await getSettings(env)), risk: await riskAccess(env, u), pex: await pexAccess(env, u) } }, 200, { 'set-cookie': sessionCookie(session, SESSION_DAYS * 86400) });
}

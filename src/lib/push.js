// Web push notifications to phones and browsers.
import { readJson } from './auth.js';
import { unb64u } from './license.js';
import { b64e, fail, json, nowIso, str } from './util.js';
import { TICKET_MAIL } from '../systems/tickets.js';
import { appName } from './config.js';

/* -------------------------------- Web push -------------------------------- */

// Notifications on a phone or computer, even with the app closed (Web Push: RFC 8030, 8291, 8292).
// Each device a person turns them on for is one row in push_subs. The site's own key pair (VAPID) is
// made once and kept in settings; its private half never leaves the server, nor goes into a backup.
// Only the browsers' own push services are reached, so a saved address can never point anywhere else.
export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^(updates\.)?push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/];
export const PUSH_PER_USER = 10; // devices per person; the oldest goes when an 11th is added
export const PUSH_PER_EVENT = 20; // devices one event reaches; each is a fetch, and a run may make 50
export const PUSH_TTL = 24 * 3600; // a phone that stays off longer misses the alert, not the request
export const enc = (s) => new TextEncoder().encode(s);
export const b64ue = (bytes) => b64e(new Uint8Array(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const concatBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

export function pushEndpointOk(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// The site's key pair, made the first time anyone asks for it.
export async function pushKeys(env) {
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'push_vapid'").first();
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const value = JSON.stringify({ pub: b64ue(await crypto.subtle.exportKey('raw', pair.publicKey)), jwk: await crypto.subtle.exportKey('jwk', pair.privateKey) });
    // Two first callers at once: the first one written wins, and both read it back.
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('push_vapid', ?) ON CONFLICT(key) DO NOTHING").bind(value).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'push_vapid'").first();
  }
  const v = JSON.parse(row.value);
  return { pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
}

// The signed note that tells the push service this message comes from this site (VAPID, RFC 8292).
export async function vapidHeader(keys, endpoint, contact) {
  const head = b64ue(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64ue(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.priv, enc(head + '.' + body));
  return `vapid t=${head}.${body}.${b64ue(sig)}, k=${keys.pub}`;
}

// The message, readable only by that one browser (RFC 8291, aes128gcm).
export async function pushEncrypt(sub, text) {
  const uaPub = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const peer = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, local.privateKey, 256);
  const hkdf = async (salt, ikm, info, bytes) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));
  const ikm = await hkdf(authSecret, new Uint8Array(shared), concatBytes(enc('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the text, then 2 = "last record", no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concatBytes(enc(text), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  return concatBytes(header, asPub, sealed);
}

// The devices of these people, newest first.
export async function pushSubsOf(env, userIds, limit) {
  const ids = [...new Set(userIds.filter((x) => Number.isInteger(x)))];
  if (!ids.length || limit <= 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT s.* FROM push_subs s JOIN users u ON u.id = s.user_id AND u.active = 1
      WHERE s.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.id DESC LIMIT ${limit}`,
  )
    .bind(...ids)
    .all();
  return results;
}

// jobs: [{ subs, build }], build(lang) giving { title, body, url, tag, urgent } in the language the device
// was turned on in. One key read and one write for the lot. A device the push service no longer knows (404, 410) is forgotten.
export async function deliverPush(env, jobs) {
  const sends = jobs.flatMap((j) => j.subs.map((s) => [s, j.build]));
  if (!sends.length) return { sent: 0 };
  const keys = await pushKeys(env);
  const now = nowIso();
  const gone = new Set();
  const ok = new Set();
  await Promise.all(
    sends.map(async ([s, build]) => {
      try {
        const m = build(s.lang === 'en' ? 'en' : 'ar');
        const text = JSON.stringify({ title: m.title.slice(0, 120), body: (m.body || '').slice(0, 240), url: m.url || '/', tag: m.tag || '', lang: s.lang, dir: s.lang === 'en' ? 'ltr' : 'rtl' });
        const res = await fetch(s.endpoint, {
          method: 'POST',
          headers: { Authorization: await vapidHeader(keys, s.endpoint, s.origin), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(PUSH_TTL), Urgency: m.urgent ? 'high' : 'normal' },
          body: await pushEncrypt(s, text),
        });
        if (res.status === 404 || res.status === 410) gone.add(s.id);
        else if (res.ok) ok.add(s.id);
        else console.error('push', res.status, new URL(s.endpoint).hostname);
      } catch (e) {
        console.error('push', e);
      }
    }),
  );
  const stmts = [];
  if (gone.size) stmts.push(env.DB.prepare(`DELETE FROM push_subs WHERE id IN (${[...gone].join(',')})`));
  if (ok.size) stmts.push(env.DB.prepare(`UPDATE push_subs SET last_ok_at = ? WHERE id IN (${[...ok].join(',')})`).bind(now));
  if (stmts.length) await env.DB.batch(stmts);
  return { sent: ok.size, gone: gone.size };
}

export const sendPush = async (env, userIds, build) => deliverPush(env, [{ subs: await pushSubsOf(env, userIds, PUSH_PER_EVENT), build }]);

// The words of a request's notification: the email's subject, then what and where.
// The organisation's name (from Settings) closes the title, so a phone shows whose alert it is.
export const ticketPush = (kind, t, settings) => (lang) => {
  const en = lang === 'en';
  const title = TICKET_MAIL[lang].subject[kind](t) + (settings ? ' - ' + appName(settings, lang) : '');
  const parts = [en ? t.cat_en : t.cat_ar, t.location_id ? (en ? t.loc_en : t.loc_ar) : t.location_text, t.description];
  return { title, body: parts.filter(Boolean).join(' · '), url: '/#/desk/tickets/' + t.id, tag: 'ticket-' + t.id, urgent: t.priority <= 2 || kind === 'escalate' };
};

// /me/push: turning notifications on and off on this device.
export async function handlePush(request, env, url, seg, method, user) {
  const route = `${method} /${seg.slice(2).join('/')}`;
  if (route === 'GET /key') return json({ key: (await pushKeys(env)).pub });
  if (route === 'POST /') {
    const body = await readJson(request);
    const endpoint = str(body.endpoint, 1000);
    const k = body.keys || {};
    const p256dh = str(k.p256dh, 200);
    const auth = str(k.auth, 100);
    if (!pushEndpointOk(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) fail(400, 'bad_subscription');
    const lang = body.lang === 'en' ? 'en' : 'ar';
    const now = nowIso();
    // The same browser turned on again (perhaps by another person signing in on it) moves to this person.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, lang, origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = ?1, p256dh = ?3, auth = ?4, lang = ?5, origin = ?6, created_at = ?7`,
      ).bind(user.id, endpoint, p256dh, auth, lang, url.origin, now),
      env.DB.prepare(`DELETE FROM push_subs WHERE user_id = ?1 AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ?1 ORDER BY id DESC LIMIT ${PUSH_PER_USER})`).bind(user.id),
    ]);
    return json({ ok: true });
  }
  if (route === 'DELETE /') {
    const body = await readJson(request);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(str(body.endpoint, 1000), user.id).run();
    return json({ ok: true });
  }
  if (route === 'POST /test') {
    const r = await sendPush(env, [user.id], (lang) => (lang === 'en' ? { title: 'Notifications are on', body: 'Requests for you will show here.', url: '/' } : { title: 'التنبيهات مفعّلة', body: 'ستظهر هنا البلاغات الخاصة بك.', url: '/' }));
    if (!r.sent) fail(502, 'push_failed');
    return json(r);
  }
  fail(404, 'not_found');
}

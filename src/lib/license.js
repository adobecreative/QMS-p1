// The license check: signature, domains, end date and the read-only grace period.
import { b64d, nowIso } from './util.js';

/* -------------------------------- license -------------------------------- */

// The public half of the owner's signing key. Licenses are signed with the private half, which
// stays with the owner (made with the license maker page). A license is the secret LICENSE:
// "PORTAL1.<payload>.<signature>", the payload naming the organisation, its domains, the end date
// and the most active users allowed (0 = no limit).
export const LICENSE_KEY = 'PORTALPUB1.BJecYV2YXfBqw9ybADDYjQVu6lUvgA_UwR_FhlTOtuepSv0EaTEiO_PMnMqJsOj_fzLMKRD4VE5Fatqa2Pz6QPk';
export const LICENSE_WARN_DAYS = 30; // a notice before the end date
export const LICENSE_GRACE_DAYS = 30; // after it everything still works, then the system is read-only
// The developer's own machine needs no license.
export const DEV_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
export const unb64u = (s) => b64d(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
export let licenseMemo = { token: null, value: null };

// The signed payload, or null when the license is missing, altered or signed by another key.
export async function readLicense(env) {
  const token = String(env.LICENSE || '').trim();
  if (licenseMemo.token === token) return licenseMemo.value;
  let value = null;
  try {
    const m = /^(PORTAL1\.([A-Za-z0-9_-]+))\.([A-Za-z0-9_-]+)$/.exec(token);
    const pub = /^(?:PORTAL|FMS)PUB1\.([A-Za-z0-9_-]{80,})$/.exec(LICENSE_KEY);
    if (m && pub) {
      const key = await crypto.subtle.importKey('raw', unb64u(pub[1]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(m[3]), new TextEncoder().encode(m[1]))) {
        const p = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
        if (p && p.v === 1 && Array.isArray(p.domains) && /^\d{4}-\d{2}-\d{2}$/.test(p.expires)) value = p;
      }
    }
  } catch {
    value = null;
  }
  licenseMemo = { token, value };
  return value;
}

export const hostAllowed = (host, domains) => domains.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d));

// ok | expiring | grace (past the end date, still working) | readonly | missing | invalid | domain (signed for another site) | dev
export async function licenseState(env, host) {
  host = String(host || '').toLowerCase();
  if (DEV_HOSTS.includes(host)) return { state: 'dev' };
  const lic = await readLicense(env);
  if (!lic) return { state: env.LICENSE ? 'invalid' : 'missing', locked: true, host };
  if (!hostAllowed(host, lic.domains)) return { state: 'domain', locked: true, host };
  const days = Math.round((Date.parse(lic.expires + 'T00:00:00Z') - Date.parse(nowIso().slice(0, 10) + 'T00:00:00Z')) / 86400000);
  const state = days > LICENSE_WARN_DAYS ? 'ok' : days >= 0 ? 'expiring' : days >= -LICENSE_GRACE_DAYS ? 'grace' : 'readonly';
  return { state, readonly: state === 'readonly', days, lic };
}
export const licenseOut = (ls, full) => ({
  state: ls.state,
  ...(ls.days !== undefined ? { days: ls.days, expires: ls.lic.expires } : {}),
  ...(ls.locked ? { host: ls.host } : {}),
  ...(full && ls.lic ? { org_ar: ls.lic.org_ar, org_en: ls.lic.org_en, domains: ls.lic.domains, max_users: ls.lic.max_users || 0, issued: ls.lic.issued || null, id: ls.lic.id || null } : {}),
});
// While read-only, people can still sign in and read everything, so nothing is lost.
export const READONLY_OPEN = ['POST /login', 'POST /login/2fa', 'POST /logout'];

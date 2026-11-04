// Small helpers: input checks, JSON replies, dates and text.

// Arabic letters, presentation forms and Arabic-Indic digits. Must match ARABIC_RE in public/app.js.
export const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const LATIN_RE = /[A-Za-z]/;
// One language per field, as the guards in public/app.js enforce: English names and identifiers
// carry no Arabic, Arabic names carry no English letters. `name` is always a person's or file's Arabic name.
export const EN_FIELDS = ['name_en', 'org_name_en', 'email', 'emp_no', 'phone', 'asset_tag', 'file_number', 'tag', 'serial_no', 'model', 'manufacturer'];
export const AR_FIELDS = ['name_ar', 'org_name_ar', 'name'];
export function checkLang(get, ar = AR_FIELDS, en = EN_FIELDS) {
  for (const k of en) {
    const v = get(k);
    if (typeof v === 'string' && ARABIC_RE.test(v)) fail(400, k.endsWith('name_en') ? 'name_en_arabic' : 'field_arabic');
  }
  for (const k of ar) {
    const v = get(k);
    if (typeof v === 'string' && LATIN_RE.test(v)) fail(400, 'name_ar_latin');
  }
}
export const RESET_MINUTES = 30;
export const MAX_TEXT_CHARS = 300000; // per PDF; keeps a row well under D1's 2MB limit
export const RESETS_PER_HOUR = 3;

/* ----------------------------- small helpers ----------------------------- */

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, code) => {
  throw new HttpError(status, code);
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });

export const nowIso = () => new Date().toISOString();
export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const b64e = (bytes) => btoa(String.fromCharCode(...bytes));
export const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const optDate = (v) => {
  const s = str(v, 10);
  if (!s) return null;
  if (!isDate(s)) fail(400, 'invalid_date');
  return s;
};
// Whole days from b to a (a - b), both YYYY-MM-DD.
export const diffDays = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

export function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
export function isTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Must match normText() in public/app.js: the stored text was normalized the same way in the browser.
// Arabic letter variants and diacritics are folded so "الإخلاء" also finds "الاخلاء". PDFs often store
// the lam-alef ligature reversed, so "لا" and "ال" are treated as the same.
export function normText(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/لا/g, 'ال')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[^\S\f]+/g, ' ')
    .trim();
}

// Fixed limits, roles and the default settings shared by every part of the worker.

// Facilities Management - Document & Policy Tracking, and maintenance requests (tickets)
// Cloudflare Worker: REST API (D1 + R2), the daily reminder job and the ticket alert job.

export const SESSION_DAYS = 7;
// Kept modest so a login fits the CPU budget of the Workers Free plan.
// The count is stored inside each hash, so it can be raised later without breaking old passwords.
export const PBKDF2_ITERATIONS = 20000;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
// Two-step sign-in: a 6-digit code from an authenticator app (TOTP, RFC 6238: SHA-1, 30 seconds),
// or one of 10 single-use recovery codes. A wrong code counts as a wrong password towards the lock.
export const TOTP_PERIOD = 30;
export const CHALLENGE_MINUTES = 5;
export const RECOVERY_COUNT = 10;
export const TWO_FA_LEVELS = ['off', 'super', 'managers'];
// One account per person. "super_admin" runs the Admin Center and is admin in every system;
// "systems_admin" is the same except that it never manages the user accounts (it only sees them);
// everyone else ("user") gets a role in each system separately, or none (no access to it).
export const ROLES = ['super_admin', 'systems_admin', 'user'];
export const ADMIN_ROLES = ['super_admin', 'systems_admin'];
export const isAdmin = (u) => ADMIN_ROLES.includes(u.role);
export const DOCS_ROLES = ['none', 'viewer', 'dept_admin'];
// dept: sees the requests sent from their own department. technician / supervisor: work in a team.
export const DESK_ROLES = ['none', 'dept', 'technician', 'supervisor'];
// Asset Management: viewer reads the register and the maintenance plans; manager changes them.
export const ASSETS_ROLES = ['none', 'viewer', 'manager'];
export const ROUNDS_ROLES = ['none', 'inspector', 'manager'];
// Quality & Accreditation (CBAHI / JCI): viewer reads the standards and readiness, assessor scores them, manager runs the lists.
export const QUALITY_ROLES = ['none', 'viewer', 'assessor', 'manager'];
// What a technician or engineer is called on screen. Stored as a key, named in public/i18n.js.
export const JOB_TITLES = ['technician', 'engineer', 'supervisor', 'specialist'];

export const DEFAULT_SETTINGS = {
  near_days: 30, // yellow starts this many days before expiry (can be overridden per file)
  repeat_days: 7, // repeat a reminder every N days while a file stays yellow/red (0 = once only)
  timezone: 'Asia/Riyadh',
  email_lang: 'ar',
  sender_name: 'منصة فكرة | Fikra Portal',
  mail_url: '',
  mail_token: '',
  // How email goes out: 'gas' = the Google Apps Script web app above (a Gmail account),
  // 'brevo' = Brevo's email API, from an address on the organization's own domain.
  // Each keeps its own settings, so switching back loses nothing.
  mail_provider: 'gas',
  brevo_key: '',
  mail_from: '',
  mail_reply_to: '',
  support_email: '',
  backup_email: '0',
  monthly_report: '0', // last month's report emailed on the 1st (Reports page)
  report_to: '', // its addresses, comma separated; empty = every active admin
  monthly_report_sent: '', // the month last sent, so it goes once
  site_url: '',
  // Branding: set from the settings page, shown in the header, login page, browser tab, emails, reports.
  org_name_ar: '',
  // Who a request can affect, in the words of the sector (hospital: patient; school: student; hotel: guest).
  who_one_ar: 'مريض',
  who_all_ar: 'المرضى',
  who_one_en: 'a patient',
  who_all_en: 'patients',
  org_name_en: '',
  logo_key: '',
  logo_type: '',
  logo_ver: '',
  // Sample departments and files added from the settings page, so they can be removed again: {"departments":[ids],"files":[ids]}.
  demo_ids: '',
  // Tickets: minutes to receive (resp) and to resolve (res) for each priority, 1 = critical ... 4 = low.
  sla_p1_resp: 15,
  sla_p1_res: 240,
  sla_p2_resp: 60,
  sla_p2_res: 480,
  sla_p3_resp: 240,
  sla_p3_res: 4320,
  sla_p4_resp: 1440,
  sla_p4_res: 20160,
  // 1 = a request is accepted only with a location QR code (the person is really there).
  require_qr: '0',
  // The AI assistant (Cloudflare Workers AI, free daily allowance). The limit keeps it inside the free allowance.
  ai_enabled: '1',
  ai_daily_limit: 300,
  // Inspection rounds: a morning email with the rounds due today and the late ones (1 = on).
  round_reminders: '1',
  round_reminded_on: '',
  // 1 = a round is saved only after the place's QR code is scanned (the inspector is really there).
  round_require_scan: '0',
  // Who must sign in with a code as well as the password: off, super (system admins), managers (admins and every manager role).
  require_2fa: 'off',
  // Spare parts: standalone (stock kept here), linked (a sub-store fed by the ERP's main warehouse),
  // erp (the ERP keeps all stock; parts are asked for here and their use recorded on the request).
  inventory_mode: 'standalone',
};
export const SLA_KEYS = [1, 2, 3, 4].flatMap((p) => [`sla_p${p}_resp`, `sla_p${p}_res`]);
export const MAX_LOGO_BYTES = 1024 * 1024;
export const DEFAULT_APP_NAME = { ar: 'منصة فكرة', en: 'Fikra Portal' };

// What every page needs to draw the brand, signed in or not.
export const brandOut = (s) => ({
  name_ar: s.org_name_ar || '',
  name_en: s.org_name_en || '',
  logo: s.logo_key ? `/api/logo?v=${encodeURIComponent(s.logo_ver)}` : null,
  support: s.support_email || '',
  who: { one_ar: s.who_one_ar, all_ar: s.who_all_ar, one_en: s.who_one_en, all_en: s.who_all_en },
});
// Both names, Arabic first, for what goes out in one piece to everyone (an email's sender, a notification).
export const appNames = (s) => {
  const ar = appName(s, 'ar');
  const en = appName(s, 'en');
  return ar === en ? ar : `${ar} | ${en}`;
};
// The name an email comes from. Left at the default, it follows the organisation's name from Settings,
// so renaming the organisation renames the sender too.
export const senderName = (s) => (!s.sender_name || s.sender_name === DEFAULT_SETTINGS.sender_name ? appNames(s) : s.sender_name);
export const appName = (s, lang) => (lang === 'en' ? s.org_name_en || s.org_name_ar : s.org_name_ar || s.org_name_en) || DEFAULT_APP_NAME[lang === 'en' ? 'en' : 'ar'];

// Recognise the logo by its first bytes, never by the name or type the browser claims.
export function logoType(bytes) {
  const b = new Uint8Array(bytes.slice(0, 16));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 2048))).replace(/^\ufeff/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

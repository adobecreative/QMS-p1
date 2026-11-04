// Sending email (Apps Script or Brevo) and the shared email layout.
import { appName, brandOut, senderName } from './config.js';
import { escHtml } from './util.js';

/* --------------------------------- email --------------------------------- */

// Sends through the Google Apps Script web app that runs under the sender's Gmail account.
export const mailReady = (s) => (s.mail_provider === 'brevo' ? !!(s.brevo_key && s.mail_from) : !!(s.mail_url && s.mail_token));
export const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// messages: [{ to: 'a@x.com,b@x.com', subject, html }].
export async function sendMail(settings, messages) {
  if (!mailReady(settings)) return { ok: false, error: 'mail_not_configured' };
  if (settings.mail_provider === 'brevo') return sendBrevo(settings, messages);
  let res;
  try {
    res = await fetch(settings.mail_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: settings.mail_token, fromName: senderName(settings), messages }),
      redirect: 'follow',
    });
  } catch {
    return { ok: false, error: 'mail_unreachable' };
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    return { ok: false, error: 'mail_bad_response' };
  }
  if (data && data.ok) return { ok: true, sent: data.sent ?? messages.length };
  return { ok: false, error: data && data.error === 'unauthorized' ? 'mail_unauthorized' : 'mail_failed', sent: (data && data.sent) || 0 };
}

// All the messages in one call (one version each), so a run of reminders stays one fetch.
export async function sendBrevo(settings, messages) {
  const versions = messages.map((m) => ({
    to: String(m.to).split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email })),
    subject: m.subject,
    htmlContent: m.html,
  }));
  const body = {
    sender: { name: senderName(settings), email: settings.mail_from },
    subject: versions[0].subject,
    htmlContent: versions[0].htmlContent,
    messageVersions: versions,
  };
  // Attachments go with a single message only (the weekly backup copy).
  if (messages.length === 1 && messages[0].attachments) body.attachment = messages[0].attachments.map((a) => ({ name: a.name, content: a.content }));
  if (settings.mail_reply_to) body.replyTo = { email: settings.mail_reply_to };
  let res;
  try {
    res = await fetch(BREVO_URL, { method: 'POST', headers: { 'api-key': settings.brevo_key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'mail_unreachable' };
  }
  if (res.ok) return { ok: true, sent: messages.length };
  const data = await res.json().catch(() => ({}));
  console.error('brevo', res.status, data && data.code, data && data.message);
  return { ok: false, error: res.status === 401 || data.code === 'unauthorized' ? 'mail_unauthorized' : 'mail_failed', sent: 0 };
}

export const EMAIL_TEXT = {
  ar: {
    dir: 'rtl',
    subject: (n, app) => `تذكير: ${n} ملف يحتاج متابعة - ${app}`,
    intro: 'الملفات التالية تحتاج متابعة:',
    cols: ['اسم الملف', 'رقم الملف', 'القسم', 'تاريخ الانتهاء', 'الحالة'],
    expired: (n) => `منتهي منذ ${n} يوم`,
    near: (n) => (n === 0 ? 'ينتهي اليوم' : `قارب على الانتهاء، متبقٍّ ${n} يوم`),
    custom: 'تذكير مخصّص',
    none: 'لا يوجد',
    open: 'فتح النظام',
    footer: (app) => `رسالة تلقائية من نظام متابعة الملفات - ${app}.`,
    resetSubject: (app) => `إعادة تعيين كلمة المرور - ${app}`,
    resetHello: (name) => `مرحبًا ${name}،`,
    resetBody: 'تلقينا طلبًا لإعادة تعيين كلمة المرور لحسابك. اضغط على الزر لاختيار كلمة مرور جديدة.',
    resetButton: 'تعيين كلمة مرور جديدة',
    resetNote: (m) => `الرابط صالح لمدة ${m} دقيقة ولمرة واحدة فقط. إذا لم تطلب ذلك، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.`,
    testSubject: (app) => `رسالة تجريبية - ${app}`,
    testBody: 'إعدادات الإرسال تعمل بشكل صحيح.',
    testFooter: (app) => `رسالة تلقائية من ${app}.`,
  },
  en: {
    dir: 'ltr',
    subject: (n, app) => `Reminder: ${n} file(s) need attention - ${app}`,
    intro: 'The following files need attention:',
    cols: ['File name', 'File no.', 'Department', 'Expiry date', 'Status'],
    expired: (n) => `Expired ${n} day(s) ago`,
    near: (n) => (n === 0 ? 'Expires today' : `Near expiry, ${n} day(s) left`),
    custom: 'Custom reminder',
    none: 'None',
    open: 'Open the system',
    footer: (app) => `Automatic message from the file tracking system - ${app}.`,
    resetSubject: (app) => `Reset your password - ${app}`,
    resetHello: (name) => `Hello ${name},`,
    resetBody: 'We received a request to reset the password for your account. Press the button to choose a new password.',
    resetButton: 'Set a new password',
    resetNote: (m) => `The link works for ${m} minutes and only once. If you did not ask for this, ignore this email and your password stays the same.`,
    testSubject: (app) => `Test message - ${app}`,
    testBody: 'Email sending is set up correctly.',
    testFooter: (app) => `Automatic message from ${app}.`,
  },
};

// Every email carries both languages: the Arabic part, then the English part (one logo at the top).
export function bothLangs(settings, build) {
  const ar = build(Object.assign({}, settings, { email_lang: 'ar' }));
  const en = build(Object.assign({}, settings, { email_lang: 'en', no_header: true }));
  return { subject: `${ar.subject} | ${en.subject}`, html: `${ar.html}<hr style="border:0;border-top:1px solid #e8dfcc;margin:26px 0">${en.html}` };
}

// Logo + organisation name at the top of every email. The logo is linked from the site, so it needs site_url.
export function emailHeader(settings) {
  if (settings.no_header) return '';
  const lang = settings.email_lang === 'en' ? 'en' : 'ar';
  const logo = settings.logo_key && settings.site_url
    ? `<img src="${escHtml(settings.site_url + brandOut(settings).logo)}" alt="" height="48" style="display:block;height:48px;width:auto;max-width:220px;border:0;margin:0 0 10px">`
    : '';
  // The organisation's name in both languages (the second line only when it differs).
  const other = appName(settings, lang === 'en' ? 'ar' : 'en');
  const second = other !== appName(settings, lang) ? `<p style="margin:-10px 0 14px;font-size:13px;color:#8a6420">${escHtml(other)}</p>` : '';
  return `${logo}<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#8a6420">${escHtml(appName(settings, lang))}</p>${second}`;
}

export function buildDigest(items, settings) {
  const L = EMAIL_TEXT[settings.email_lang === 'en' ? 'en' : 'ar'];
  const app = appName(settings, settings.email_lang);
  const align = L.dir === 'rtl' ? 'right' : 'left';
  const cell = `padding:8px 10px;border-bottom:1px solid #f1eadb;text-align:${align};font-size:14px`;
  const rows = items
    .map(({ f, st, reasons }) => {
      const notes = [];
      if (reasons.includes('expired')) notes.push(L.expired(-st.days));
      if (reasons.includes('near')) notes.push(L.near(st.days));
      if (reasons.includes('custom')) notes.push(L.custom);
      const color = reasons.includes('expired') ? '#7d2f27' : reasons.includes('near') ? '#5f4a10' : '#1f1a12';
      const dept = settings.email_lang === 'en' ? f.dept_en : f.dept_ar;
      const name = settings.email_lang === 'en' ? f.name_en || f.name : f.name;
      return `<tr><td style="${cell};font-weight:bold">${escHtml(name)}</td><td style="${cell}" dir="ltr">${escHtml(f.file_number)}</td><td style="${cell}">${escHtml(dept)}</td><td style="${cell}" dir="ltr">${escHtml(f.expiry_date || L.none)}</td><td style="${cell};color:${color};font-weight:bold">${escHtml(notes.join(' - '))}</td></tr>`;
    })
    .join('');
  const head = L.cols.map((c) => `<th style="${cell};background:#faf7f0;font-size:13px">${escHtml(c)}</th>`).join('');
  const link = settings.site_url ? `<p style="margin:16px 0 0"><a href="${escHtml(settings.site_url)}" style="color:#8a6420">${escHtml(L.open)}</a></p>` : '';
  const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${align}">${emailHeader(settings)}<p style="font-size:15px">${escHtml(L.intro)}</p><table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${link}<p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
  return { subject: L.subject(items.length, app), html };
}

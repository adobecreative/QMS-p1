// The full backup by link: every week (and on "send now") a download link goes to the backup address
// (set by the owner, else the owner's own email). The link gives one ZIP with backup.json (all the data) and
// files/<storage key> (every uploaded file), built while it downloads, so its size is not limited
// by memory. A link works for BACKUP_LINK_DAYS days and BACKUP_LINK_USES downloads.
import { appName } from './config.js';
import { fullBackupData, crc32Update } from './backup.js';
import { logStmt } from './db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from './mail.js';
import { escHtml, nowIso, sha256Hex, toHex } from './util.js';

export const BACKUP_LINK_DAYS = 7;
export const BACKUP_LINK_USES = 3;
export const LINK_PATH = '/api/backup/link/';

/* ------------------------------ ZIP stream ------------------------------ */

// Writes a ZIP (stored, no compression: the files are PDFs and pictures already) to `writable`.
// entries: [{ name, open: async () => Uint8Array | ReadableStream | null }]; an entry that opens to null is left out.
// Each file's CRC and size follow its data (data descriptor), so nothing is held in memory; ZIP64 records
// are added when the archive passes 4 GB or 65535 entries (or always with force64, for the tests).
export async function writeZip(writable, entries, { force64 = false } = {}) {
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const dosDate = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const MAX32 = 0xffffffff;
  let offset = 0;
  const central = [];
  const put = async (bytes) => {
    await w.write(bytes);
    offset += bytes.length;
  };
  try {
    for (const e of entries) {
      const body = await e.open();
      if (body == null) continue;
      const name = enc.encode(e.name);
      const start = offset;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0808, true); // sizes after the data, UTF-8 names
      lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint16(26, name.length, true);
      await put(new Uint8Array(lh.buffer));
      await put(name);
      let crc = 0;
      let size = 0;
      if (body instanceof Uint8Array) {
        crc = crc32Update(0, body);
        size = body.length;
        await put(body);
      } else {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          crc = crc32Update(crc, chunk);
          size += chunk.length;
          await put(chunk);
        }
      }
      if (size >= MAX32) throw new Error('file over 4 GB: ' + e.name);
      const dd = new DataView(new ArrayBuffer(16));
      dd.setUint32(0, 0x08074b50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, size, true);
      dd.setUint32(12, size, true);
      await put(new Uint8Array(dd.buffer));
      central.push({ name, crc, size, start });
    }
    const cdStart = offset;
    for (const c of central) {
      const big = force64 || c.start >= MAX32;
      const extra = big ? 12 : 0;
      const ch = new DataView(new ArrayBuffer(46 + extra));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 45, true);
      ch.setUint16(6, big ? 45 : 20, true);
      ch.setUint16(8, 0x0808, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.name.length, true);
      ch.setUint16(30, extra, true);
      ch.setUint32(42, big ? MAX32 : c.start, true);
      const head = new Uint8Array(ch.buffer);
      await put(head.subarray(0, 46));
      await put(c.name);
      if (big) {
        // ZIP64 extra field: the local header's offset only (the sizes fit in 32 bits).
        const x = new DataView(head.buffer, 46, 12);
        x.setUint16(0, 0x0001, true);
        x.setUint16(2, 8, true);
        x.setBigUint64(4, BigInt(c.start), true);
        await put(head.subarray(46));
      }
    }
    const cdSize = offset - cdStart;
    const zip64 = force64 || central.length > 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const recStart = offset;
      const r = new DataView(new ArrayBuffer(56 + 20));
      r.setUint32(0, 0x06064b50, true);
      r.setBigUint64(4, 44n, true);
      r.setUint16(12, 45, true);
      r.setUint16(14, 45, true);
      r.setBigUint64(24, BigInt(central.length), true);
      r.setBigUint64(32, BigInt(central.length), true);
      r.setBigUint64(40, BigInt(cdSize), true);
      r.setBigUint64(48, BigInt(cdStart), true);
      r.setUint32(56, 0x07064b50, true);
      r.setBigUint64(64, BigInt(recStart), true);
      r.setUint32(72, 1, true);
      await put(new Uint8Array(r.buffer));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, zip64 ? 0xffff : central.length, true);
    end.setUint16(10, zip64 ? 0xffff : central.length, true);
    end.setUint32(12, zip64 ? MAX32 : cdSize, true);
    end.setUint32(16, zip64 ? MAX32 : cdStart, true);
    await put(new Uint8Array(end.buffer));
    await w.close();
  } catch (err) {
    console.error('backup zip', err);
    await w.abort(err).catch(() => {});
  }
}

// Every object in storage except the weekly copies, through all pages of the listing.
export async function storageFiles(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.FILES.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.filter((o) => !o.key.startsWith('backups/'));
}

// The whole backup as one ZIP download.
export async function fullBackupZip(env, ctx, by) {
  const [data, files] = await Promise.all([fullBackupData(env), storageFiles(env)]);
  const json = new TextEncoder().encode(JSON.stringify({ app: 'facilities-tracker', kind: 'full', format: 1, created_at: nowIso(), created_by: by, data }));
  const entries = [
    { name: 'backup.json', open: async () => json },
    ...files.map((o) => ({ name: 'files/' + o.key, open: async () => ((await env.FILES.get(o.key)) || {}).body || null })),
  ];
  const { readable, writable } = new TransformStream();
  const job = writeZip(writable, entries);
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  return readable;
}

/* ------------------------------ the links ------------------------------- */

// The weekly address: the one the owner set, else the owner's own email.
export async function backupAddress(env, settings) {
  if (settings.backup_link_to) return settings.backup_link_to;
  const owner = await env.DB.prepare('SELECT email FROM users ORDER BY id LIMIT 1').first();
  return owner ? owner.email : '';
}

// A new link to the backup address, by email. Old links that ran out are cleared.
export async function sendBackupLink(env, settings, by) {
  const to = await backupAddress(env, settings);
  if (!to) return { ok: false, error: 'not_found' };
  if (!mailReady(settings)) return { ok: false, error: 'mail_not_configured' };
  if (!settings.site_url) return { ok: false, error: 'site_url_missing' };
  const token = toHex(crypto.getRandomValues(new Uint8Array(24)));
  const now = nowIso();
  const expires = new Date(Date.now() + BACKUP_LINK_DAYS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM backup_links WHERE expires_at < ? OR uses >= max_uses').bind(now),
    env.DB.prepare('INSERT INTO backup_links (token_hash, email, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)').bind(await sha256Hex(token), to, now, expires, BACKUP_LINK_USES),
  ]);
  const link = new URL(LINK_PATH + token, settings.site_url).href;
  const until = expires.slice(0, 10);
  const mail = bothLangs(settings, (s) => {
    const ar = s.email_lang !== 'en';
    const app = appName(s, s.email_lang);
    const L = ar
      ? { title: 'النسخة الاحتياطية الكاملة', text: `ملف ZIP فيه كل بيانات ${app} وكل الملفات المرفوعة.`, open: 'تنزيل النسخة', note: `الرابط صالح حتى ${until} ولـ ${BACKUP_LINK_USES} تنزيلات. احفظ الملف في مكان آمن.` }
      : { title: 'Full backup', text: `One ZIP with all ${app} data and every uploaded file.`, open: 'Download the backup', note: `The link works until ${until} and for ${BACKUP_LINK_USES} downloads. Keep the file somewhere safe.` };
    return {
      subject: `${L.title} - ${app}`,
      html: `<div dir="${ar ? 'rtl' : 'ltr'}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${ar ? 'right' : 'left'}">${emailHeader(s)}<p>${escHtml(L.text)}</p>
      <p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.open)}</a></p>
      <p style="color:#6b604c;font-size:13px">${escHtml(L.note)}</p></div>`,
    };
  });
  const sent = await sendMail(settings, [{ to, ...mail }]);
  await logStmt(env, by, 'backup', 'system', null, to, { link: sent.ok ? 'sent' : sent.error }).run();
  return sent.ok ? { ok: true, to, expires_at: expires } : { ok: false, error: sent.error || 'mail_failed' };
}

// The newest link, for the owner's backup panel.
export async function lastBackupLink(env) {
  return env.DB.prepare('SELECT email, created_at, expires_at, uses, max_uses FROM backup_links ORDER BY id DESC LIMIT 1').first();
}

// GET /api/backup/link/<token>: no sign-in, the token is the key. Each download counts, even one that stops halfway.
export async function handleBackupLink(request, env, ctx, token) {
  const html = (status, ar, en) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:Tahoma,sans-serif;text-align:center;padding:48px 16px;color:#1f1a12"><p dir="rtl">${ar}</p><p>${en}</p></body>`, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  if (!/^[0-9a-f]{48}$/.test(token || '')) return html(404, 'الرابط غير صحيح.', 'This link is not valid.');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT * FROM backup_links WHERE token_hash = ?').bind(hash).first();
  if (!row) return html(404, 'الرابط غير صحيح.', 'This link is not valid.');
  const now = nowIso();
  const res = await env.DB.prepare('UPDATE backup_links SET uses = uses + 1, last_used_at = ? WHERE id = ? AND uses < max_uses AND expires_at > ?').bind(now, row.id, now).run();
  if (!res.meta || !res.meta.changes) return html(410, 'انتهت صلاحية الرابط.', 'This link has expired.');
  await logStmt(env, { id: null, name: row.email }, 'backup', 'system', null, row.email, { link: 'download', use: row.uses + 1 }).run();
  const host = new URL(request.url).hostname.replace(/[^\w.-]/g, '');
  const body = await fullBackupZip(env, ctx, row.email);
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="backup-${host}-${now.slice(0, 10)}.zip"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

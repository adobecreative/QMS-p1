// Full backup data, the weekly automatic copy and its email to the owner.
import { appName } from './config.js';
import { getSettings, logStmt } from './db.js';
import { bothLangs, emailHeader, mailReady, sendMail } from './mail.js';
import { escHtml, nowIso } from './util.js';

// Everything needed to rebuild the system, as the system owner's backup holds it.
// Password hashes, sessions and the mail and push keys are never included.
export async function fullBackupData(env) {
  const all = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [departments, docTypes, users, files, acks, logs, settingsRows, staff, categories, locations, tickets, ticketEvents, assets, pmPlans, pmDone, assetTypes, roundForms, roundItems, roundPlaces, rounds, roundAnswers, vendors, vendorDocs, contracts, contractAssets, contractVisits, stores, parts, stock, stockMoves, partRequests, stdChapters, standards, stdAssessments, fmsSnapshots] = await Promise.all([
    all('SELECT * FROM departments ORDER BY id'),
    all('SELECT * FROM doc_types ORDER BY id'),
    all('SELECT id, name, name_en, email, role, docs_role, desk_role, assets_role, rounds_role, quality_role, department_id, job_title, active, created_at FROM users ORDER BY id'),
    all('SELECT * FROM files ORDER BY id'),
    all('SELECT * FROM acks ORDER BY file_id, user_id'),
    all('SELECT * FROM logs ORDER BY id'),
    all("SELECT key, value FROM settings WHERE key NOT IN ('mail_token', 'brevo_key', 'push_vapid', 'link_key') ORDER BY key"),
    all('SELECT * FROM staff ORDER BY id'),
    all('SELECT * FROM ticket_categories ORDER BY id'),
    all('SELECT * FROM locations ORDER BY id'),
    // The tracking secrets and device addresses stay out: they are only hashes, of no use in a copy.
    all('SELECT * FROM tickets ORDER BY id').then((rows) => rows.map(({ track_hash, ip_hash, ...rest }) => rest)),
    all('SELECT * FROM ticket_events ORDER BY id'),
    all('SELECT * FROM assets ORDER BY id'),
    all('SELECT * FROM pm_plans ORDER BY id'),
    all('SELECT * FROM pm_done ORDER BY id'),
    all('SELECT * FROM asset_types ORDER BY id'),
    all('SELECT * FROM round_forms ORDER BY id'),
    all('SELECT * FROM round_items ORDER BY id'),
    all('SELECT * FROM round_places ORDER BY id'),
    all('SELECT * FROM rounds ORDER BY id'),
    all('SELECT * FROM round_answers ORDER BY id'),
    // Supplier papers and contract PDFs are files in storage; the copy keeps their names, not the files.
    all('SELECT * FROM vendors ORDER BY id'),
    all('SELECT * FROM vendor_docs ORDER BY id'),
    all('SELECT * FROM contracts ORDER BY id'),
    all('SELECT * FROM contract_assets ORDER BY contract_id, asset_id'),
    all('SELECT * FROM contract_visits ORDER BY id'),
    all('SELECT * FROM stores ORDER BY id'),
    all('SELECT * FROM parts ORDER BY id'),
    all('SELECT * FROM stock ORDER BY part_id, store_id'),
    all('SELECT * FROM stock_moves ORDER BY id'),
    all('SELECT * FROM part_requests ORDER BY id'),
    all('SELECT * FROM std_chapters ORDER BY sort, code'),
    all('SELECT * FROM standards ORDER BY id'),
    all('SELECT * FROM std_assessments ORDER BY id'),
    all('SELECT * FROM fms_snapshots ORDER BY day'),
  ]);
  return {
    departments, doc_types: docTypes, users, files, acks, logs, settings: Object.fromEntries(settingsRows.map((r) => [r.key, r.value])),
    staff, ticket_categories: categories, locations, tickets, ticket_events: ticketEvents, assets, pm_plans: pmPlans, pm_done: pmDone, asset_types: assetTypes,
    round_forms: roundForms, round_items: roundItems, round_places: roundPlaces, rounds, round_answers: roundAnswers,
    vendors, vendor_docs: vendorDocs, contracts, contract_assets: contractAssets, contract_visits: contractVisits,
    stores, parts, stock, stock_moves: stockMoves, part_requests: partRequests,
    std_chapters: stdChapters, standards, std_assessments: stdAssessments, fms_snapshots: fmsSnapshots,
  };
}

// Every Friday the system keeps its own copy of the data in storage, the last AUTO_BACKUP_KEEP of them.
export const AUTO_BACKUP_PREFIX = 'backups/auto/';
export const AUTO_BACKUP_KEEP = 8;
// Friday 02:00-02:14 UTC (05:00 Riyadh): the first 15-minute run of that window.
export const isAutoBackupTick = (d) => d.getUTCDay() === 5 && d.getUTCHours() === 2 && d.getUTCMinutes() < 15;
export async function runAutoBackup(env) {
  const data = await fullBackupData(env);
  const name = nowIso().slice(0, 10) + '.json';
  const body = JSON.stringify({ app: 'facilities-tracker', kind: 'full', format: 1, created_at: nowIso(), created_by: 'system', data });
  await env.FILES.put(AUTO_BACKUP_PREFIX + name, body, { httpMetadata: { contentType: 'application/json' } });
  const { objects } = await env.FILES.list({ prefix: AUTO_BACKUP_PREFIX });
  const old = objects.map((o) => o.key).sort().reverse().slice(AUTO_BACKUP_KEEP);
  if (old.length) await env.FILES.delete(old);
  // A copy away from Cloudflare too, in the owner's mailbox, when the owner turned it on.
  const settings = await getSettings(env);
  const mailed = settings.backup_email === '1' ? await emailBackup(env, settings, name, body) : null;
  await logStmt(env, null, 'backup', 'system', null, name, { auto: true, bytes: body.length, ...(mailed ? { emailed: mailed.ok ? 'yes' : mailed.error } : {}) }).run();
  return { name, bytes: body.length, removed: old.length, ...(mailed ? { emailed: mailed.ok || mailed.error } : {}) };
}

// The data part of the backup as a compressed ZIP attached to an email to the system owner.
// The PDFs stay in storage (too large for email); this copy is everything else.
export const BACKUP_MAIL_MAX = 3.5 * 1024 * 1024;
export async function emailBackup(env, settings, name, body) {
  if (!mailReady(settings)) return { ok: false, error: 'mail_not_configured' };
  const owner = await env.DB.prepare('SELECT email FROM users ORDER BY id LIMIT 1').first();
  if (!owner) return { ok: false, error: 'not_found' };
  const zip = await zipDeflate('backup.json', new TextEncoder().encode(body));
  if (zip.length > BACKUP_MAIL_MAX) return { ok: false, error: 'backup_too_large' };
  const day = name.replace('.json', '');
  const mail = bothLangs(settings, (s) => {
    const ar = s.email_lang !== 'en';
    const app = appName(s, s.email_lang);
    const text = ar
      ? ['النسخة الاحتياطية الأسبوعية', `مرفق نسخة من بيانات ${app} بتاريخ ${day}. احفظ الملف في مكان آمن. ملفات PDF غير مضمّنة لكبر حجمها، وتبقى في التخزين وفي النسخة الكاملة التي تُنزَّل من الإعدادات.`]
      : ['Weekly backup', `Attached is a copy of the ${app} data dated ${day}. Keep the file somewhere safe. PDF files are not included because of their size; they stay in storage and in the full backup downloaded from the settings.`];
    return { subject: `${text[0]} - ${app}`, html: `<div dir="${ar ? 'rtl' : 'ltr'}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${ar ? 'right' : 'left'}">${emailHeader(s)}<p>${escHtml(text[1])}</p></div>` };
  });
  return sendMail(settings, [{ to: owner.email, ...mail, attachments: [{ name: `backup-${day}.zip`, content: toBase64(zip) }] }]);
}

// A one-file ZIP with deflate compression (Brevo accepts .zip attachments, not .json).
export let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export async function zipDeflate(fileName, data) {
  const packed = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const nameBytes = new TextEncoder().encode(fileName);
  const crc = crc32(data);
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const head = (central) => {
    const v = new DataView(new ArrayBuffer(central ? 46 : 30));
    let i = 0;
    v.setUint32(i, central ? 0x02014b50 : 0x04034b50, true);
    i += 4;
    if (central) {
      v.setUint16(i, 20, true);
      i += 2;
    }
    v.setUint16(i, 20, true);
    v.setUint16(i + 2, 0x0800, true);
    v.setUint16(i + 4, 8, true);
    v.setUint16(i + 8, DOS_DATE, true);
    v.setUint32(i + 10, crc, true);
    v.setUint32(i + 14, packed.length, true);
    v.setUint32(i + 18, data.length, true);
    v.setUint16(i + 22, nameBytes.length, true);
    return new Uint8Array(v.buffer);
  };
  const local = head(false);
  const central = head(true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, central.length + nameBytes.length, true);
  end.setUint32(16, local.length + nameBytes.length + packed.length, true);
  const parts = [local, nameBytes, packed, central, nameBytes, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

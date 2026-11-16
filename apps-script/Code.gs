/**
 * Gmail sender, and the backup copy in Google Drive.
 *
 * 1. Open https://script.google.com with the Gmail account that should appear as the sender.
 * 2. New project -> paste this file -> change TOKEN below to a long secret of your own.
 * 3. Deploy -> New deployment -> Web app -> Execute as: Me -> Who has access: Anyone.
 * 4. Copy the web app URL (ends with /exec) and paste it, with the same TOKEN,
 *    into the system's Settings page.
 *
 * If you edit this file later: Deploy -> Manage deployments -> Edit -> New version.
 *
 * Backup copy in Google Drive (optional, turned on from the system's backup settings): the same web app
 * also saves the weekly data copy and every uploaded file in this account's Drive, in the folder
 * "Fikra backups/<site>". After pasting this version: choose the function "authorize" at the top, press
 * Run and allow Drive access once, then Deploy -> Manage deployments -> Edit -> New version.
 */

const TOKEN = 'CHANGE-THIS-TO-A-LONG-SECRET';

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad_request' });
  }
  if (!data || data.token !== TOKEN || TOKEN === 'CHANGE-THIS-TO-A-LONG-SECRET') {
    return reply({ ok: false, error: 'unauthorized' });
  }
  if (typeof data.action === 'string' && data.action.indexOf('drive_') === 0) {
    return reply(drive(data));
  }

  const messages = Array.isArray(data.messages) ? data.messages : [data];
  let sent = 0;
  const errors = [];
  messages.forEach(function (m) {
    try {
      MailApp.sendEmail({
        to: m.to,
        subject: m.subject,
        htmlBody: m.html,
        name: m.fromName || data.fromName || 'Fikra Portal',
        // The weekly backup copy comes as a ZIP attachment; meeting invitations carry a calendar file (.ics).
        attachments: (m.attachments || []).map(function (a) {
          return Utilities.newBlob(Utilities.base64Decode(a.content), a.type || 'application/zip', a.name);
        }),
      });
      sent++;
    } catch (err) {
      errors.push({ to: m.to, error: String(err) });
    }
  });

  return reply({ ok: errors.length === 0, sent: sent, errors: errors, remaining: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor after adding the Drive copy, so Google asks for Drive access.
function authorize() {
  DriveApp.getRootFolder();
  MailApp.getRemainingDailyQuota();
}

// The backup copy: Fikra backups/<site>/data/<day>.zip and Fikra backups/<site>/files/<the file's storage path>.
const BACKUP_FOLDER = 'Fikra backups';

function drive(data) {
  try {
    const root = folderAt(DriveApp.getRootFolder(), [BACKUP_FOLDER, cleanName(data.root) || 'site']);
    if (data.action === 'drive_check') {
      return { ok: true, drive: true, url: root.getUrl() };
    }
    if (data.action === 'drive_put') {
      const parts = String(data.path || '').split('/').map(cleanName).filter(function (p) {
        return p && p !== '.' && p !== '..';
      });
      if (!parts.length) return { ok: false, drive: true, error: 'bad_path' };
      const name = parts.pop();
      const folder = folderAt(root, parts);
      // A file saved again replaces the older one (it goes to the Drive trash).
      const old = folder.getFilesByName(name);
      while (old.hasNext()) old.next().setTrashed(true);
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(data.content || ''), data.type || 'application/octet-stream', name));
      return { ok: true, drive: true, id: file.getId() };
    }
    if (data.action === 'drive_prune') {
      // Keeps the newest copies (the names are dates), the older ones go to the Drive trash.
      const folder = folderAt(root, [cleanName(data.folder) || 'data']);
      const files = [];
      const it = folder.getFiles();
      while (it.hasNext()) files.push(it.next());
      files.sort(function (a, b) {
        return a.getName() < b.getName() ? 1 : -1;
      });
      const extra = files.slice(Math.max(1, Number(data.keep) || 8));
      extra.forEach(function (f) {
        f.setTrashed(true);
      });
      return { ok: true, drive: true, removed: extra.length };
    }
    return { ok: false, drive: true, error: 'bad_request' };
  } catch (err) {
    return { ok: false, drive: true, error: String(err) };
  }
}

function folderAt(parent, names) {
  names.forEach(function (n) {
    const found = parent.getFoldersByName(n);
    parent = found.hasNext() ? found.next() : parent.createFolder(n);
  });
  return parent;
}

function cleanName(v) {
  return String(v || '').replace(/[\\/]/g, '-').trim().slice(0, 200);
}

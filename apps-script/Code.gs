/**
 * Facilities Management - Gmail sender.
 *
 * 1. Open https://script.google.com with the Gmail account that should appear as the sender.
 * 2. New project -> paste this file -> change TOKEN below to a long secret of your own.
 * 3. Deploy -> New deployment -> Web app -> Execute as: Me -> Who has access: Anyone.
 * 4. Copy the web app URL (ends with /exec) and paste it, with the same TOKEN,
 *    into the system's Settings page.
 *
 * If you edit this file later: Deploy -> Manage deployments -> Edit -> New version.
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
        // The weekly backup copy comes as a ZIP attachment.
        attachments: (m.attachments || []).map(function (a) {
          return Utilities.newBlob(Utilities.base64Decode(a.content), 'application/zip', a.name);
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

import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const host = process.env.SMTP_HOST;
  transporter = host
    ? nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      })
    : null;
  return transporter;
}

export type EmailMessage = { to: string; subject: string; html: string; text: string };

/** Sends an e-mail, or logs it when SMTP is not configured. Returns false when only logged. */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.info(`[email:console] to=${message.to} subject="${message.subject}"`);
    return false;
  }
  await t.sendMail({ from: process.env.MAIL_FROM ?? "QMS <qms@localhost>", ...message });
  return true;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SEVERITY_COLOR: Record<string, string> = {
  INFO: "#0f766e",
  SUCCESS: "#15803d",
  WARNING: "#b45309",
  CRITICAL: "#b91c1c",
};

/** A simple, mail-client-safe template that works for Arabic (RTL) and English. */
export function renderNotificationEmail(input: {
  locale: string;
  title: string;
  body?: string | null;
  url?: string | null;
  severity: string;
}): Pick<EmailMessage, "subject" | "html" | "text"> {
  const rtl = input.locale === "ar";
  const button = rtl ? "فتح في نظام الجودة" : "Open in QMS";
  const footer = rtl
    ? "رسالة آلية من نظام إدارة الجودة. يمكنك تغيير تفضيلات الإشعارات من صفحة الإشعارات."
    : "Automated message from the Quality Management System. You can change your notification preferences in the app.";
  const color = SEVERITY_COLOR[input.severity] ?? SEVERITY_COLOR.INFO;
  const html = `<!doctype html><html lang="${input.locale}" dir="${rtl ? "rtl" : "ltr"}"><body style="margin:0;background:#f1f5f9;font-family:Tahoma,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border-top:4px solid ${color}">
<tr><td style="padding:24px;text-align:${rtl ? "right" : "left"}">
<h1 style="font-size:18px;color:#0f172a;margin:0 0 12px">${escape(input.title)}</h1>
${input.body ? `<p style="font-size:14px;line-height:1.7;color:#334155;margin:0 0 20px;white-space:pre-line">${escape(input.body)}</p>` : ""}
${input.url ? `<a href="${escape(input.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">${button}</a>` : ""}
<p style="font-size:12px;color:#94a3b8;margin:24px 0 0">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [input.title, input.body, input.url].filter(Boolean).join("\n\n");
  return { subject: input.title, html, text };
}

import { db } from "@/core/db";
import { renderNotificationEmail, sendEmail } from "./email";

const MAX_ATTEMPTS = 5;

/** Absolute link for e-mails: APP_URL + /<locale> + link */
export function absoluteLink(locale: string, link?: string | null) {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/${locale}${link.startsWith("/") ? link : `/${link}`}`;
}

/**
 * Send queued e-mails. Each delivery is claimed with an optimistic update so
 * two workers never send the same e-mail.
 */
export async function sendPendingEmails(limit = 25): Promise<number> {
  const pending = await db.notificationDelivery.findMany({
    where: { channel: "EMAIL", status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { notification: { include: { user: { select: { email: true, locale: true, isActive: true } } } } },
  });

  let sent = 0;
  for (const d of pending) {
    const claim = await db.notificationDelivery.updateMany({
      where: { id: d.id, status: "PENDING", attempts: d.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;

    const { notification: n } = d;
    if (!n.user.isActive || !n.user.email) {
      await db.notificationDelivery.update({ where: { id: d.id }, data: { status: "SKIPPED" } });
      continue;
    }
    try {
      const message = renderNotificationEmail({
        locale: n.user.locale,
        title: n.title,
        body: n.body,
        url: absoluteLink(n.user.locale, n.link),
        severity: n.severity,
      });
      const delivered = await sendEmail({ to: n.user.email, ...message });
      await db.notificationDelivery.update({
        where: { id: d.id },
        data: { status: delivered ? "SENT" : "SKIPPED", sentAt: new Date(), lastError: null },
      });
      if (delivered) sent++;
    } catch (err) {
      const attempts = d.attempts + 1;
      await db.notificationDelivery.update({
        where: { id: d.id },
        data: {
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        },
      });
    }
  }
  return sent;
}

import { Prisma, type Severity } from "@prisma/client";
import type { Db } from "@/core/db";
import { t, type Bilingual } from "@/core/i18n";
import { resolveAudience, type Audience } from "./audience";
import { typeDef, type NotificationType } from "./catalog";

export type NotifyInput = {
  type: NotificationType | (string & {});
  audience: Audience;
  title: Bilingual;
  body?: Bilingual;
  /** App-relative link without locale, e.g. "/chapters/IPC". */
  link?: string;
  severity?: Severity;
  chapterCode?: string | null;
  entityType?: string;
  entityId?: string;
  /** The event being handled — makes re-delivery idempotent. */
  eventId?: string;
};

/**
 * Create in-app notifications (in each recipient's language) and queue
 * e-mails according to the type defaults and the user's preferences.
 * Returns the number of notifications created.
 *
 * Usually called from an event subscriber, not directly from a page.
 */
export async function notify(client: Db, input: NotifyInput): Promise<number> {
  const userIds = await resolveAudience(client, input.audience);
  if (!userIds.length) return 0;

  const def = typeDef(input.type);
  const [users, prefs, already] = await Promise.all([
    client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, locale: true, email: true } }),
    client.notificationPreference.findMany({ where: { userId: { in: userIds }, type: input.type } }),
    input.eventId
      ? client.notification.findMany({ where: { eventId: input.eventId, type: input.type }, select: { userId: true } })
      : Promise.resolve([]),
  ]);
  const prefByUser = new Map(prefs.map((p) => [p.userId, p]));
  const notified = new Set(already.map((n) => n.userId));

  let created = 0;
  for (const user of users) {
    if (notified.has(user.id)) continue; // event re-delivered: already notified
    const pref = prefByUser.get(user.id);
    const inApp = def.mandatory ? true : (pref?.inApp ?? def.defaults.inApp);
    const email = def.mandatory ? true : (pref?.email ?? def.defaults.email);
    if (!inApp && !email) continue;

    try {
      await client.notification.create({
        data: {
          userId: user.id,
          type: input.type,
          title: t(input.title, user.locale),
          body: input.body ? t(input.body, user.locale) : null,
          link: input.link,
          severity: input.severity ?? "INFO",
          chapterCode: input.chapterCode ?? null,
          entityType: input.entityType,
          entityId: input.entityId,
          eventId: input.eventId,
          // When the user turned in-app off we still keep the row (for the
          // e-mail log) but mark it read so it does not show in the bell.
          readAt: inApp ? null : new Date(),
          deliveries: email && user.email ? { create: { channel: "EMAIL" } } : undefined,
        },
      });
      created++;
    } catch (err) {
      // Two workers raced on the same event: the other one already notified.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  return created;
}

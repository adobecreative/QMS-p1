import { db } from "@/core/db";
import { eventSchemas, externalAlertSchema } from "@/core/events/catalog";
import { subscribe } from "@/core/events/registry";
import { notify } from "./notify";

/** Foundation subscribers: turn foundation events into notifications. */

subscribe("notification.broadcast_requested", "notifications.broadcast", async (event) => {
  const p = eventSchemas["notification.broadcast_requested"].parse(event.payload);
  await notify(db, {
    type: "system.broadcast",
    audience: p.audience,
    title: p.title,
    body: p.body,
    link: p.link,
    severity: p.severity,
    eventId: event.id,
  });
});

subscribe("user.created", "notifications.welcome", async (event) => {
  const { userId } = eventSchemas["user.created"].parse(event.payload);
  await notify(db, {
    type: "system.welcome",
    audience: { userIds: [userId] },
    title: { ar: "مرحباً بك في نظام إدارة الجودة", en: "Welcome to the Quality Management System" },
    body: {
      ar: "تم إنشاء حسابك. ستصلك هنا تنبيهات المهام والمراجعات والانتهاء الخاصة بك.",
      en: "Your account is ready. Your task, review and expiry alerts will appear here.",
    },
    link: "/",
    eventId: event.id,
  });
});

subscribe("user.roles_changed", "notifications.roles_changed", async (event) => {
  const { userId } = eventSchemas["user.roles_changed"].parse(event.payload);
  await notify(db, {
    type: "system.roles_changed",
    audience: { userIds: [userId] },
    title: { ar: "تم تحديث صلاحياتك", en: "Your roles were updated" },
    link: "/profile",
    eventId: event.id,
  });
});

/**
 * Any external system can raise an alert by adding an `alert` object to its
 * event payload (see docs/integrations.md).
 */
subscribe("external.*", "notifications.external_alert", async (event) => {
  const payload = event.payload as { alert?: unknown } | null;
  if (!payload?.alert) return;
  const alert = externalAlertSchema.parse(payload.alert);
  await notify(db, {
    type: "integration.alert",
    audience: alert.audience,
    title: alert.title,
    body: alert.body,
    link: alert.link,
    severity: alert.severity,
    chapterCode: alert.chapterCode ?? event.chapterCode,
    entityType: event.entityType ?? undefined,
    entityId: event.entityId ?? undefined,
    eventId: event.id,
  });
});

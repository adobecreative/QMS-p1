import type { Bilingual } from "@/core/i18n";

/**
 * Notification types. Each type has default channels; users can change them
 * on their preferences page unless the type is `mandatory`.
 *
 * Each module adds its own types here in its PR (e.g. "document.review_due",
 * "incident.assigned", "license.expiring").
 */
export type NotificationTypeDef = {
  label: Bilingual;
  defaults: { inApp: boolean; email: boolean };
  /** Mandatory types ignore user preferences (always in-app + e-mail). */
  mandatory?: boolean;
};

export const NOTIFICATION_TYPES = {
  "system.broadcast": {
    label: { ar: "تعميم من الإدارة", en: "Management announcement" },
    defaults: { inApp: true, email: true },
    mandatory: true,
  },
  "system.welcome": {
    label: { ar: "ترحيب بالحساب الجديد", en: "New account welcome" },
    defaults: { inApp: true, email: true },
  },
  "system.roles_changed": {
    label: { ar: "تغيير الأدوار والصلاحيات", en: "Role changes" },
    defaults: { inApp: true, email: false },
  },
  "integration.alert": {
    label: { ar: "تنبيه من نظام مرتبط (FMS، البوابة...)", en: "Alert from a connected system (FMS, portal...)" },
    defaults: { inApp: true, email: true },
  },
} satisfies Record<string, NotificationTypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function typeDef(type: string): NotificationTypeDef {
  return (
    (NOTIFICATION_TYPES as Record<string, NotificationTypeDef>)[type] ?? {
      label: { ar: type, en: type },
      defaults: { inApp: true, email: false },
    }
  );
}

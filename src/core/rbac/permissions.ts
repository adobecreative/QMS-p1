/**
 * Permission catalog.
 *
 * Permissions are plain strings "<area>.<action>". Roles (DB table `Role`)
 * hold a list of these keys. Wildcards are supported in roles:
 *   "*"          every permission
 *   "users.*"    every permission in the users area
 *
 * Each module adds its own permissions here in its PR, so this file is the
 * single place to see what the system can authorise.
 */
export const PERMISSIONS = {
  // --- Foundation -----------------------------------------------------------
  "users.view": { ar: "عرض المستخدمين", en: "View users" },
  "users.manage": { ar: "إدارة المستخدمين والأدوار", en: "Manage users and role assignments" },
  "departments.manage": { ar: "إدارة الأقسام", en: "Manage departments" },
  "chapters.manage": { ar: "إدارة الفصول", en: "Manage chapters" },
  "roles.manage": { ar: "إدارة الأدوار والصلاحيات", en: "Manage roles and permissions" },
  "audit.view": { ar: "عرض سجل التدقيق", en: "View audit trail" },
  "integrations.manage": { ar: "إدارة الربط مع الأنظمة", en: "Manage system integrations" },
  "notifications.broadcast": { ar: "إرسال تعميم", en: "Send broadcast announcements" },
  "dashboard.executive": { ar: "عرض لوحة الإدارة", en: "View executive dashboard" },
} as const;

export type Permission = keyof typeof PERMISSIONS | (string & {});

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[];

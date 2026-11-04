import type { Permission } from "@/core/rbac/permissions";

/** Admin area entries; each is shown only to users holding its permission. */
export const ADMIN_LINKS: { href: string; key: string; icon: string; permission: Permission }[] = [
  { href: "/admin/users", key: "users", icon: "Users", permission: "users.view" },
  { href: "/admin/departments", key: "departments", icon: "Network", permission: "departments.manage" },
  { href: "/admin/chapters", key: "chaptersAdmin", icon: "LayoutGrid", permission: "chapters.manage" },
  { href: "/admin/roles", key: "roles", icon: "KeyRound", permission: "roles.manage" },
  { href: "/admin/broadcast", key: "broadcast", icon: "Megaphone", permission: "notifications.broadcast" },
  { href: "/admin/integrations", key: "integrations", icon: "Plug", permission: "integrations.manage" },
  { href: "/admin/audit", key: "audit", icon: "ScrollText", permission: "audit.view" },
];

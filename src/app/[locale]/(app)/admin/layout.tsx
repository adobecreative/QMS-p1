import { getLocale } from "next-intl/server";
import { requireUser } from "@/core/auth/session";
import { redirect } from "@/i18n/navigation";
import { ADMIN_LINKS } from "@/components/layout/admin-links";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!ADMIN_LINKS.some((l) => user.can(l.permission))) {
    redirect({ href: "/forbidden", locale: await getLocale() });
  }
  return children;
}

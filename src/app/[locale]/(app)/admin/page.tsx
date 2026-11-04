import { getTranslations } from "next-intl/server";
import { requireUser } from "@/core/auth/session";
import { Link } from "@/i18n/navigation";
import { ADMIN_LINKS } from "@/components/layout/admin-links";
import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/ui/page-header";

export default async function AdminHome() {
  const user = await requireUser();
  const t = await getTranslations("nav");
  const ta = await getTranslations("admin");
  return (
    <>
      <PageHeader title={ta("title")} description={ta("intro")} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ADMIN_LINKS.filter((l) => user.can(l.permission)).map((l) => (
          <Link key={l.href} href={l.href} className="flex items-center gap-3 rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200 hover:ring-brand-600">
            <Icon name={l.icon} className="size-5 text-brand-700" />
            <span className="font-medium">{t(l.key)}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

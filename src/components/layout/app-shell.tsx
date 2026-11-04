import { getLocale, getTranslations } from "next-intl/server";
import { Bell, Home, LayoutGrid, LogOut, Settings, UserRound } from "lucide-react";
import { db } from "@/core/db";
import { pick } from "@/core/i18n";
import { signOut } from "@/core/auth/auth";
import type { CurrentUser } from "@/core/auth/session";
import { Link } from "@/i18n/navigation";
import { Icon } from "@/components/ui/icon";
import { NavLink } from "./nav-link";
import { NotificationBell } from "./notification-bell";
import { LocaleSwitcher } from "./locale-switcher";
import { ADMIN_LINKS } from "./admin-links";

/** The signed-in layout: sidebar with chapters + header with bell, language and user. */
export async function AppShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations("nav");
  const tApp = await getTranslations("app");
  const chapters = await db.chapter.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  const showAdmin = ADMIN_LINKS.some((l) => user.can(l.permission));

  const sidebar = (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto p-4 text-sm">
      <div className="space-y-1">
        <NavLink href="/" exact icon={<Home className="size-4" />}>{t("home")}</NavLink>
        <NavLink href="/chapters" exact icon={<LayoutGrid className="size-4" />}>{t("chapters")}</NavLink>
        <NavLink href="/notifications" icon={<Bell className="size-4" />}>{t("notifications")}</NavLink>
      </div>
      <div>
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("chapters")}</p>
        <div className="space-y-0.5">
          {chapters.map((c) => (
            <NavLink
              key={c.code}
              href={`/chapters/${c.code}`}
              icon={<Icon name={c.icon} className="size-4" style={{ color: c.color }} />}
            >
              <span className="truncate">{pick(c, "name", locale)}</span>
              <span className="ms-auto font-mono text-[10px] text-slate-400">{c.code}</span>
            </NavLink>
          ))}
        </div>
      </div>
      {showAdmin && (
        <div className="mt-auto space-y-1 border-t border-slate-200 pt-4">
          <NavLink href="/admin" icon={<Settings className="size-4" />}>{t("admin")}</NavLink>
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-e border-slate-200 bg-white lg:block">
        <Link href="/" className="flex h-16 items-center gap-2 border-b border-slate-200 px-5 font-bold text-brand-800">
          <Icon name="ShieldCheck" className="size-6" />
          {tApp("name")}
        </Link>
        <div className="h-[calc(100vh-4rem)]">{sidebar}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:px-8">
          <details className="relative lg:hidden">
            <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-sm ring-1 ring-slate-300">{t("menu")}</summary>
            <div className="absolute start-0 top-10 z-30 max-h-[80vh] w-72 rounded-lg bg-white shadow-lg ring-1 ring-slate-200">{sidebar}</div>
          </details>
          <span className="font-semibold text-brand-800 lg:hidden">{tApp("short")}</span>
          <div className="ms-auto flex items-center gap-2">
            <LocaleSwitcher label={t("language")} />
            <NotificationBell />
            <Link href="/profile" className="hidden items-center gap-2 rounded-md px-2 py-1 text-sm text-slate-700 hover:bg-slate-100 sm:flex">
              <UserRound className="size-4" aria-hidden />
              {locale === "ar" ? user.nameAr || user.name : user.name}
            </Link>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: `/${locale}/login` });
              }}
            >
              <button type="submit" title={t("signOut")} className="rounded-md p-2 text-slate-500 hover:bg-slate-100">
                <LogOut className="size-4 rtl:rotate-180" aria-hidden />
                <span className="sr-only">{t("signOut")}</span>
              </button>
            </form>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

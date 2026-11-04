import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Settings2 } from "lucide-react";
import { db } from "@/core/db";
import { requireUser } from "@/core/auth/session";
import { Link } from "@/i18n/navigation";
import { markAllRead, markRead } from "@/modules/notifications/actions";
import { Card } from "@/components/ui/card";
import { Badge, severityTone } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/components/ui/cn";

const PAGE_SIZE = 50;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  const unreadOnly = filter === "unread";
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("notifications");
  const ts = await getTranslations("severity");
  const format = await getFormatter();
  const items = await db.notification.findMany({
    where: { userId: user.id, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={
          <>
            <Link href="/notifications/preferences" className={buttonClass("secondary")}>
              <Settings2 className="size-4" aria-hidden />
              {t("preferences")}
            </Link>
            <form action={markAllRead}>
              <Button type="submit">{t("markAllRead")}</Button>
            </form>
          </>
        }
      />
      <div className="mb-4 flex gap-2 text-sm">
        {[
          { key: "all", label: t("all"), href: "/notifications" },
          { key: "unread", label: t("unread"), href: "/notifications?filter=unread" },
        ].map((f) => (
          <Link
            key={f.key}
            href={f.href}
            className={cn(
              "rounded-full px-3 py-1",
              (unreadOnly ? "unread" : "all") === f.key ? "bg-brand-700 text-white" : "bg-white ring-1 ring-slate-300",
            )}
          >
            {f.label}
          </Link>
        ))}
      </div>
      <Card>
        {items.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((n) => (
              <li key={n.id} className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4 sm:flex-nowrap", !n.readAt && "bg-brand-50/40")}>
                <Badge tone={severityTone[n.severity]}>{ts(n.severity)}</Badge>
                <div className="min-w-0 flex-1 basis-48">
                  <p className={cn("text-sm", !n.readAt && "font-semibold")}>{n.title}</p>
                  {n.body && <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{n.body}</p>}
                  <p className="mt-1 text-xs text-slate-400">
                    {n.chapterCode && <bdi className="me-2 font-mono">{n.chapterCode}</bdi>}
                    <bdi>{format.dateTime(n.createdAt, { dateStyle: "medium", timeStyle: "short" })}</bdi>
                  </p>
                </div>
                <div className="flex w-full shrink-0 justify-end gap-2 sm:w-auto">
                  {n.link && (
                    <a href={`/${locale}/notifications/open/${n.id}`} className={buttonClass("secondary", "sm")}>
                      {t("open")}
                    </a>
                  )}
                  {!n.readAt && (
                    <form action={markRead.bind(null, n.id)}>
                      <Button type="submit" variant="ghost" size="sm">{t("markRead")}</Button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

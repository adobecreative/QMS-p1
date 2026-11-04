import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requireUser } from "@/core/auth/session";
import { CHAPTER_TABS } from "@/core/chapters/tabs";
import { t as tr } from "@/core/i18n";
import { Link } from "@/i18n/navigation";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, severityTone } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { ChapterTile } from "./chapter-tile";

export default async function HomePage() {
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("home");
  const tc = await getTranslations("common");
  const ts = await getTranslations("severity");
  const format = await getFormatter();
  const [chapters, notifications] = await Promise.all([
    db.chapter.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.notification.findMany({ where: { userId: user.id, readAt: null }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  const name = locale === "ar" ? user.nameAr || user.name : user.name;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("greeting", { name })}</h1>
        <p className="mt-1 text-slate-600">{t("intro")}</p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {chapters.map((c) => (
          <ChapterTile key={c.code} chapter={c} locale={locale} />
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={t("latestNotifications")}
            action={<Link href="/notifications" className="text-sm text-brand-700 hover:underline">{tc("viewAll")}</Link>}
          />
          <CardBody className="p-0">
            {notifications.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500">{t("noNotifications")}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {notifications.map((n) => (
                  <li key={n.id}>
                    <a href={`/${locale}/notifications/open/${n.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50">
                      <Badge tone={severityTone[n.severity]}>{n.chapterCode ?? ts(n.severity)}</Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{n.title}</span>
                        <span className="text-xs text-slate-500">{format.relativeTime(n.createdAt)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("engines")} subtitle={t("enginesIntro")} />
          <CardBody>
            <ul className="grid gap-2 sm:grid-cols-2">
              {CHAPTER_TABS.filter((x) => x.key !== "overview").map((tab) => (
                <li key={tab.key} className="flex items-center gap-2 text-sm">
                  <Icon name={tab.icon} className="size-4 text-brand-700" />
                  <span>{tr(tab.label, locale)}</span>
                  {!tab.ready && <Badge className="ms-auto">{tc("comingSoon")}</Badge>}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

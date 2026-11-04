import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Hammer } from "lucide-react";
import { db } from "@/core/db";
import { requireUser } from "@/core/auth/session";
import { CHAPTER_TABS } from "@/core/chapters/tabs";
import { pick, t as tr } from "@/core/i18n";
import { Link } from "@/i18n/navigation";
import { chapterTabComponents } from "@/modules/chapter-tabs";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/components/ui/cn";

export default async function ChapterPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { code } = await params;
  const { tab: tabKey = "overview" } = await searchParams;
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("chapters");

  const chapter = await db.chapter.findUnique({ where: { code: code.toUpperCase() } });
  if (!chapter || !chapter.isActive) notFound();

  const tab = CHAPTER_TABS.find((x) => x.key === tabKey) ?? CHAPTER_TABS[0];
  const TabComponent = tab.ready ? chapterTabComponents[tab.key] : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="flex size-12 items-center justify-center rounded-xl" style={{ background: `${chapter.color}1a`, color: chapter.color }}>
          <Icon name={chapter.icon} className="size-6" />
        </span>
        <div>
          <p className="font-mono text-xs font-semibold text-slate-400">CBAHI · {chapter.code}</p>
          <h1 className="text-2xl font-bold">{pick(chapter, "name", locale)}</h1>
        </div>
      </div>

      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Chapter sections">
        {CHAPTER_TABS.map((x) => (
          <Link
            key={x.key}
            href={{ pathname: `/chapters/${chapter.code}`, query: x.key === "overview" ? {} : { tab: x.key } }}
            aria-current={x.key === tab.key ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors",
              x.key === tab.key ? "font-medium" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
            style={x.key === tab.key ? { borderColor: chapter.color, color: chapter.color } : undefined}
          >
            <Icon name={x.icon} className="size-4" />
            {tr(x.label, locale)}
          </Link>
        ))}
      </nav>

      {TabComponent ? (
        <TabComponent chapter={chapter} user={user} locale={locale} />
      ) : (
        <Card>
          <EmptyState
            icon={<Hammer className="size-8" aria-hidden />}
            title={t("tabSoonTitle", { module: tr(tab.label, locale) })}
            body={t("tabSoonBody")}
          />
        </Card>
      )}
    </div>
  );
}

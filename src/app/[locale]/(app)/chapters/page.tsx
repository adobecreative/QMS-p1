import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { PageHeader } from "@/components/ui/page-header";
import { ChapterTile } from "../chapter-tile";

export default async function ChaptersPage() {
  const locale = await getLocale();
  const t = await getTranslations("chapters");
  const tApp = await getTranslations("app");
  const chapters = await db.chapter.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  return (
    <>
      <PageHeader title={t("title")} description={tApp("hospital")} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {chapters.map((c) => (
          <ChapterTile key={c.code} chapter={c} locale={locale} />
        ))}
      </div>
    </>
  );
}

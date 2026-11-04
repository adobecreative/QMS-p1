import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { saveChapter } from "@/modules/admin/chapters";
import { ActionForm } from "@/components/ui/action-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ChapterFields } from "../chapter-fields";

export default async function EditChapterPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("chapters.manage");
  const { id } = await params;
  const locale = await getLocale();
  const tc = await getTranslations("common");
  const [chapter, users] = await Promise.all([
    db.chapter.findUnique({ where: { id } }),
    db.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  if (!chapter) notFound();
  return (
    <>
      <PageHeader title={pick(chapter, "name", locale)} description={`CBAHI · ${chapter.code}`} />
      <Card><CardBody>
        <ActionForm action={saveChapter} submitLabel={tc("save")}>
          <ChapterFields chapter={chapter} users={users} />
        </ActionForm>
      </CardBody></Card>
    </>
  );
}

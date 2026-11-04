import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { saveChapter } from "@/modules/admin/chapters";
import { Link } from "@/i18n/navigation";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { ChapterFields } from "./chapter-fields";

export default async function ChaptersAdminPage() {
  await requirePermission("chapters.manage");
  const locale = await getLocale();
  const t = await getTranslations("admin.chapters");
  const tc = await getTranslations("common");
  const tch = await getTranslations("chapters");
  const [chapters, users] = await Promise.all([
    db.chapter.findMany({ include: { lead: true }, orderBy: { sortOrder: "asc" } }),
    db.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <Card className="mb-6">
        <Table>
          <thead><tr><Th>{tc("code")}</Th><Th>{tc("name")}</Th><Th>{tch("jci")}</Th><Th>{tch("lead")}</Th><Th>{tc("status")}</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {chapters.map((c) => (
              <Tr key={c.id}>
                <Td className="font-mono text-xs">{c.code}</Td>
                <Td>
                  <Link href={`/admin/chapters/${c.id}`} className="flex items-center gap-2 font-medium text-brand-800 hover:underline">
                    <Icon name={c.icon} className="size-4" style={{ color: c.color }} />
                    {pick(c, "name", locale)}
                  </Link>
                </Td>
                <Td className="text-xs">{c.jciCodes.join(", ") || tc("none")}</Td>
                <Td className="text-xs">{c.lead ? (locale === "ar" ? c.lead.nameAr || c.lead.name : c.lead.name) : tch("noLead")}</Td>
                <Td>{c.isActive ? <Badge tone="green">{tc("active")}</Badge> : <Badge>{tc("inactive")}</Badge>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title={t("new")} />
        <CardBody>
          <ActionForm action={saveChapter} submitLabel={tc("create")}>
            <ChapterFields users={users} />
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}

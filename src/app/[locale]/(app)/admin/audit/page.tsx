import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { buttonClass } from "@/components/ui/button";

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePermission("audit.view");
  const { q = "" } = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations("admin.audit");
  const tc = await getTranslations("common");
  const format = await getFormatter();
  const logs = await db.auditLog.findMany({
    where: q ? { OR: [{ action: { contains: q } }, { entityType: { contains: q } }, { entityId: q }, { chapterCode: q.toUpperCase() }] } : {},
    include: { actor: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <>
      <PageHeader title={t("title")} />
      <form className="mb-4 flex gap-2">
        <Input name="q" defaultValue={q} placeholder="user.update, Chapter, IPC …" className="max-w-sm" dir="ltr" />
        <button className={buttonClass("secondary")}>{tc("search")}</button>
      </form>
      <Card>
        <Table>
          <thead><tr><Th>{t("when")}</Th><Th>{t("actor")}</Th><Th>{t("action")}</Th><Th>{t("entity")}</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {logs.map((l) => (
              <Tr key={l.id}>
                <Td className="whitespace-nowrap text-xs">{format.dateTime(l.createdAt, { dateStyle: "short", timeStyle: "short" })}</Td>
                <Td className="text-xs">{l.actor ? (locale === "ar" ? l.actor.nameAr || l.actor.name : l.actor.name) : t("system")}</Td>
                <Td className="font-mono text-xs">{l.action}</Td>
                <Td className="font-mono text-xs">{l.entityType}{l.chapterCode && ` · ${l.chapterCode}`}</Td>
                <Td className="max-w-sm truncate font-mono text-[11px] text-slate-500" dir="ltr">{l.details ? JSON.stringify(l.details) : ""}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { saveDepartment } from "@/modules/admin/departments";
import { Link } from "@/i18n/navigation";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { DepartmentFields } from "./department-fields";

export default async function DepartmentsPage() {
  await requirePermission("departments.manage");
  const locale = await getLocale();
  const t = await getTranslations("admin.departments");
  const tc = await getTranslations("common");
  const [departments, users] = await Promise.all([
    db.department.findMany({ include: { parent: true, head: true, _count: { select: { members: true } } }, orderBy: { code: "asc" } }),
    db.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHeader title={t("title")} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <Table>
            <thead><tr><Th>{tc("code")}</Th><Th>{tc("name")}</Th><Th>{t("parent")}</Th><Th>{t("head")}</Th><Th>{t("members")}</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {departments.map((d) => (
                <Tr key={d.id}>
                  <Td className="font-mono text-xs">{d.code}</Td>
                  <Td>
                    <Link href={`/admin/departments/${d.id}`} className="font-medium text-brand-800 hover:underline">{pick(d, "name", locale)}</Link>
                    {!d.isActive && <Badge className="ms-2">{tc("inactive")}</Badge>}
                  </Td>
                  <Td className="text-xs">{d.parent?.code ?? tc("none")}</Td>
                  <Td className="text-xs">{d.head ? (locale === "ar" ? d.head.nameAr || d.head.name : d.head.name) : tc("none")}</Td>
                  <Td>{d._count.members}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title={t("new")} />
          <CardBody>
            <ActionForm action={saveDepartment} submitLabel={tc("create")}>
              <DepartmentFields departments={departments} users={users} />
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

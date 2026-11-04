import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { saveDepartment } from "@/modules/admin/departments";
import { ActionForm } from "@/components/ui/action-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { DepartmentFields } from "../department-fields";

export default async function EditDepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("departments.manage");
  const { id } = await params;
  const locale = await getLocale();
  const tc = await getTranslations("common");
  const [department, departments, users] = await Promise.all([
    db.department.findUnique({ where: { id } }),
    db.department.findMany({ orderBy: { code: "asc" } }),
    db.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  if (!department) notFound();
  return (
    <>
      <PageHeader title={pick(department, "name", locale)} description={department.code} />
      <Card><CardBody>
        <ActionForm action={saveDepartment} submitLabel={tc("save")}>
          <DepartmentFields department={department} departments={departments} users={users} />
        </ActionForm>
      </CardBody></Card>
    </>
  );
}

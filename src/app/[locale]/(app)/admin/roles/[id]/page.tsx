import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { saveRole } from "@/modules/admin/roles";
import { ActionForm } from "@/components/ui/action-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RoleFields } from "../role-fields";

export default async function EditRolePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("roles.manage");
  const { id } = await params;
  const locale = await getLocale();
  const t = await getTranslations("admin.roles");
  const tc = await getTranslations("common");
  const role = await db.role.findUnique({ where: { id } });
  if (!role) notFound();
  return (
    <>
      <PageHeader title={pick(role, "name", locale)} description={role.isSystem ? t("systemHint") : pick(role, "description", locale)} />
      <Card><CardBody>
        {role.isSystem ? (
          <RoleFields role={role} readOnly />
        ) : (
          <ActionForm action={saveRole} submitLabel={tc("save")}>
            <RoleFields role={role} />
          </ActionForm>
        )}
      </CardBody></Card>
    </>
  );
}

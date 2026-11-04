import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { saveUser } from "@/modules/admin/users";
import { ActionForm } from "@/components/ui/action-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { UserFields } from "../user-fields";

export default async function NewUserPage() {
  await requirePermission("users.manage");
  const t = await getTranslations("admin.users");
  const tc = await getTranslations("common");
  const departments = await db.department.findMany({ where: { isActive: true }, orderBy: { code: "asc" } });
  return (
    <>
      <PageHeader title={t("new")} />
      <Card><CardBody>
        <ActionForm action={saveUser} submitLabel={tc("create")}>
          <UserFields departments={departments} />
        </ActionForm>
      </CardBody></Card>
    </>
  );
}

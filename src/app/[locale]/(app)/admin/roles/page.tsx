import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { saveRole } from "@/modules/admin/roles";
import { Link } from "@/i18n/navigation";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { RoleFields } from "./role-fields";

export default async function RolesPage() {
  await requirePermission("roles.manage");
  const locale = await getLocale();
  const t = await getTranslations("admin.roles");
  const tc = await getTranslations("common");
  const roles = await db.role.findMany({ include: { _count: { select: { users: true } } }, orderBy: [{ isSystem: "desc" }, { nameEn: "asc" }] });
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <Card className="mb-6">
        <Table>
          <thead><tr><Th>{tc("name")}</Th><Th>{t("key")}</Th><Th>{t("permissions")}</Th><Th>{t("users")}</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {roles.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <Link href={`/admin/roles/${r.id}`} className="font-medium text-brand-800 hover:underline">{pick(r, "name", locale)}</Link>
                  {r.isSystem && <Badge className="ms-2">{t("system")}</Badge>}
                  <p className="text-xs text-slate-500">{pick(r, "description", locale)}</p>
                </Td>
                <Td className="font-mono text-xs">{r.key}</Td>
                <Td className="font-mono text-xs">{r.permissions.join(", ") || tc("none")}</Td>
                <Td>{r._count.users}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title={t("new")} />
        <CardBody>
          <ActionForm action={saveRole} submitLabel={tc("create")}>
            <RoleFields />
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}

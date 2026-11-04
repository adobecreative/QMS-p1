import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { addUserRole, removeUserRole, saveUser } from "@/modules/admin/users";
import { ActionForm } from "@/components/ui/action-form";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { UserFields } from "../user-fields";

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("users.manage");
  const { id } = await params;
  const locale = await getLocale();
  const t = await getTranslations("admin.users");
  const tc = await getTranslations("common");
  const [user, departments, roles, chapters] = await Promise.all([
    db.user.findUnique({ where: { id }, include: { roles: { include: { role: true, chapter: true, department: true } } } }),
    db.department.findMany({ orderBy: { code: "asc" } }),
    db.role.findMany({ orderBy: { nameEn: "asc" } }),
    db.chapter.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);
  if (!user) notFound();

  return (
    <>
      <PageHeader title={locale === "ar" ? user.nameAr || user.name : user.name} description={user.email} />
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardBody>
            <ActionForm action={saveUser} submitLabel={tc("save")}>
              <UserFields user={user} departments={departments} />
            </ActionForm>
          </CardBody>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title={t("roles")} />
          <Table>
            <thead><tr><Th>{t("roles")}</Th><Th>{t("scope")}</Th><Th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {user.roles.map((r) => (
                <Tr key={r.id}>
                  <Td>{pick(r.role, "name", locale)}</Td>
                  <Td className="text-xs">
                    {r.chapter ? `${tc("chapter")}: ${r.chapter.code}` : r.department ? `${tc("department")}: ${r.department.code}` : tc("hospitalWide")}
                  </Td>
                  <Td className="text-end">
                    <form action={removeUserRole.bind(null, r.id)}>
                      <Button type="submit" size="sm" variant="ghost">{t("removeRole")}</Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <CardBody className="border-t border-slate-100">
            <ActionForm action={addUserRole.bind(null, user.id)} submitLabel={t("addRole")}>
              <Field label={t("roles")}>
                <Select name="roleId" required>
                  {roles.map((r) => <option key={r.id} value={r.id}>{pick(r, "name", locale)}</option>)}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={tc("chapter")}>
                  <Select name="chapterId" defaultValue="">
                    <option value="">{tc("hospitalWide")}</option>
                    {chapters.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
                  </Select>
                </Field>
                <Field label={tc("department")}>
                  <Select name="departmentId" defaultValue="">
                    <option value="">{tc("hospitalWide")}</option>
                    {departments.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
                  </Select>
                </Field>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { Link } from "@/i18n/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string; dep?: string }> }) {
  const user = await requirePermission("users.view");
  const { q = "", dep = "" } = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations("admin.users");
  const tc = await getTranslations("common");
  const format = await getFormatter();

  const [users, departments] = await Promise.all([
    db.user.findMany({
      where: {
        ...(dep && { departmentId: dep }),
        ...(q && {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { nameAr: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
            { employeeNo: { contains: q } },
          ],
        }),
      },
      include: { department: true, roles: { include: { role: true, chapter: true, department: true } } },
      orderBy: { name: "asc" },
      take: 200,
    }),
    db.department.findMany({ orderBy: { code: "asc" } }),
  ]);
  const canManage = user.can("users.manage");

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={canManage && (
          <Link href="/admin/users/new" className={buttonClass()}>
            <Plus className="size-4" aria-hidden /> {t("new")}
          </Link>
        )}
      />
      <form className="mb-4 flex flex-wrap gap-2">
        <Input name="q" defaultValue={q} placeholder={tc("search")} className="max-w-xs" />
        <Select name="dep" defaultValue={dep} className="max-w-xs">
          <option value="">{tc("allDepartments")}</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{pick(d, "name", locale)}</option>)}
        </Select>
        <button className={buttonClass("secondary")}>{tc("search")}</button>
      </form>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>{tc("name")}</Th>
              <Th>{tc("department")}</Th>
              <Th>{t("roles")}</Th>
              <Th>{t("lastLogin")}</Th>
              <Th>{tc("status")}</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map((u) => (
              <Tr key={u.id}>
                <Td>
                  {canManage ? (
                    <Link href={`/admin/users/${u.id}`} className="font-medium text-brand-800 hover:underline">
                      {locale === "ar" ? u.nameAr || u.name : u.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{locale === "ar" ? u.nameAr || u.name : u.name}</span>
                  )}
                  <div className="text-xs text-slate-500" dir="ltr">{u.email}</div>
                </Td>
                <Td>{u.department ? pick(u.department, "name", locale) : tc("none")}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r.id} tone="brand">
                        {pick(r.role, "name", locale)}
                        {r.chapter && ` · ${r.chapter.code}`}
                        {r.department && ` · ${r.department.code}`}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="text-xs">{u.lastLoginAt ? format.relativeTime(u.lastLoginAt) : t("never")}</Td>
                <Td>{u.isActive ? <Badge tone="green">{tc("active")}</Badge> : <Badge>{tc("inactive")}</Badge>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

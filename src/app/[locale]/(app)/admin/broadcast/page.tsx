import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { sendBroadcast } from "@/modules/admin/broadcast";
import { ActionForm } from "@/components/ui/action-form";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";

export default async function BroadcastPage() {
  await requirePermission("notifications.broadcast");
  const locale = await getLocale();
  const t = await getTranslations("admin.broadcast");
  const ts = await getTranslations("severity");
  const tc = await getTranslations("common");
  const [departments, roles] = await Promise.all([
    db.department.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
    db.role.findMany({ orderBy: { nameEn: "asc" } }),
  ]);
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <Card className="max-w-3xl"><CardBody>
        <ActionForm action={sendBroadcast} submitLabel={t("send")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("titleAr")}><Input name="titleAr" required /></Field>
            <Field label={t("titleEn")}><Input name="titleEn" required dir="ltr" /></Field>
            <Field label={t("bodyAr")}><Textarea name="bodyAr" /></Field>
            <Field label={t("bodyEn")}><Textarea name="bodyEn" dir="ltr" /></Field>
            <Field label={t("severity")}>
              <Select name="severity" defaultValue="INFO">
                {(["INFO", "SUCCESS", "WARNING", "CRITICAL"] as const).map((s) => <option key={s} value={s}>{ts(s)}</option>)}
              </Select>
            </Field>
            <Field label={t("audience")}>
              <Select name="audience" defaultValue="all">
                <option value="all">{t("everyone")}</option>
                <option value="department">{t("byDepartment")}</option>
                <option value="role">{t("byRole")}</option>
              </Select>
            </Field>
            <Field label={tc("department")}>
              <Select name="departmentId" defaultValue="">
                <option value="">{tc("none")}</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{pick(d, "name", locale)}</option>)}
              </Select>
            </Field>
            <Field label={t("byRole")}>
              <Select name="roleKey" defaultValue="">
                <option value="">{tc("none")}</option>
                {roles.map((r) => <option key={r.id} value={r.key}>{pick(r, "name", locale)}</option>)}
              </Select>
            </Field>
          </div>
        </ActionForm>
      </CardBody></Card>
    </>
  );
}

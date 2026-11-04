import type { Department, User } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";
import { pick } from "@/core/i18n";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";

export async function UserFields({ user, departments }: { user?: User; departments: Department[] }) {
  const locale = await getLocale();
  const t = await getTranslations("admin.users");
  const tc = await getTranslations("common");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {user && <input type="hidden" name="id" value={user.id} />}
      <Field label={tc("nameEn")}><Input name="name" required defaultValue={user?.name} /></Field>
      <Field label={tc("nameAr")}><Input name="nameAr" defaultValue={user?.nameAr ?? ""} /></Field>
      <Field label={tc("email")}><Input name="email" type="email" required dir="ltr" defaultValue={user?.email} /></Field>
      <Field label={t("employeeNo")}><Input name="employeeNo" dir="ltr" defaultValue={user?.employeeNo ?? ""} /></Field>
      <Field label={t("jobTitle")}><Input name="jobTitle" defaultValue={user?.jobTitle ?? ""} /></Field>
      <Field label={t("phone")}><Input name="phone" dir="ltr" defaultValue={user?.phone ?? ""} /></Field>
      <Field label={tc("department")}>
        <Select name="departmentId" defaultValue={user?.departmentId ?? ""}>
          <option value="">{tc("none")}</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.code} · {pick(d, "name", locale)}</option>)}
        </Select>
      </Field>
      <Field label={t("locale")}>
        <Select name="locale" defaultValue={user?.locale ?? "ar"}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <Field label={t("password")} hint={t("passwordHint")}>
        <Input name="password" type="password" minLength={10} autoComplete="new-password" dir="ltr" />
      </Field>
      <div className="flex items-end pb-2">
        <Checkbox name="isActive" label={t("isActive")} defaultChecked={user?.isActive ?? true} />
      </div>
    </div>
  );
}

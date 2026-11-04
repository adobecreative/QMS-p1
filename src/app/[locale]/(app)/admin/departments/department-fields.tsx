import type { Department, User } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";
import { pick } from "@/core/i18n";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";

export async function DepartmentFields({ department, departments, users }: { department?: Department; departments: Department[]; users: User[] }) {
  const locale = await getLocale();
  const t = await getTranslations("admin.departments");
  const tc = await getTranslations("common");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {department && <input type="hidden" name="id" value={department.id} />}
      <Field label={tc("code")}><Input name="code" required dir="ltr" defaultValue={department?.code} /></Field>
      <div className="flex items-end pb-2"><Checkbox name="isActive" label={tc("active")} defaultChecked={department?.isActive ?? true} /></div>
      <Field label={tc("nameAr")}><Input name="nameAr" required defaultValue={department?.nameAr} /></Field>
      <Field label={tc("nameEn")}><Input name="nameEn" required defaultValue={department?.nameEn} /></Field>
      <Field label={t("parent")}>
        <Select name="parentId" defaultValue={department?.parentId ?? ""}>
          <option value="">{tc("none")}</option>
          {departments.filter((d) => d.id !== department?.id).map((d) => <option key={d.id} value={d.id}>{d.code} · {pick(d, "name", locale)}</option>)}
        </Select>
      </Field>
      <Field label={t("head")}>
        <Select name="headId" defaultValue={department?.headId ?? ""}>
          <option value="">{tc("none")}</option>
          {users.map((u) => <option key={u.id} value={u.id}>{locale === "ar" ? u.nameAr || u.name : u.name}</option>)}
        </Select>
      </Field>
    </div>
  );
}

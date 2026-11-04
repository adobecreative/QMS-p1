import type { Role } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";
import { PERMISSIONS } from "@/core/rbac/permissions";
import { t as tr } from "@/core/i18n";
import { Field, Input } from "@/components/ui/form";

export async function RoleFields({ role, readOnly }: { role?: Role; readOnly?: boolean }) {
  const locale = await getLocale();
  const t = await getTranslations("admin.roles");
  const tc = await getTranslations("common");
  const granted = new Set(role?.permissions ?? []);
  const areas = Object.entries(PERMISSIONS).reduce<Record<string, [string, { ar: string; en: string }][]>>((acc, entry) => {
    const area = entry[0].split(".")[0];
    (acc[area] ??= []).push(entry);
    return acc;
  }, {});
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      {role && <input type="hidden" name="id" value={role.id} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("key")}><Input name="key" required dir="ltr" defaultValue={role?.key} /></Field>
        <Field label={tc("nameAr")}><Input name="nameAr" required defaultValue={role?.nameAr} /></Field>
        <Field label={tc("nameEn")}><Input name="nameEn" required defaultValue={role?.nameEn} /></Field>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">{t("permissions")}</p>
        {granted.has("*") && <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">* — all permissions</p>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(areas).map(([area, perms]) => (
            <div key={area} className="rounded-md p-3 ring-1 ring-slate-200">
              <p className="mb-2 font-mono text-xs text-slate-500">{area}</p>
              {perms.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 py-0.5 text-sm">
                  <input type="checkbox" name="permissions" value={key} defaultChecked={granted.has(key) || granted.has(`${area}.*`)} className="size-4 rounded border-slate-300 text-brand-700" />
                  {tr(label, locale)}
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

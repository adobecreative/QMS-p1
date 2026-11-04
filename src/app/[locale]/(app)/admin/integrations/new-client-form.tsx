"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createApiClient } from "@/modules/admin/integrations";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

export function NewClientForm({ scopes }: { scopes: { key: string; label: string }[] }) {
  const t = useTranslations("admin.integrations");
  const tc = useTranslations("common");
  const [state, action] = useActionState(createApiClient, null);
  const key = state?.data?.key as string | undefined;
  return (
    <form action={action} className="space-y-4">
      <Field label={tc("name")} hint="fms, portal, his" error={state?.fieldErrors?.name}>
        <Input name="name" required dir="ltr" pattern="[a-z][a-z0-9_]{1,30}" />
      </Field>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">{t("scopes")}</legend>
        {scopes.map((s) => (
          <label key={s.key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="scopes" value={s.key} defaultChecked className="size-4 rounded border-slate-300 text-brand-700" />
            <span className="font-mono text-xs">{s.key}</span> {s.label}
          </label>
        ))}
      </fieldset>
      {key && (
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-1">{t("keyOnce")}</p>
          <code className="block break-all rounded bg-white p-2 text-xs" dir="ltr">{key}</code>
        </div>
      )}
      <FormMessage state={key ? null : state} />
      <SubmitButton>{tc("create")}</SubmitButton>
    </form>
  );
}

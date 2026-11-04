"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { changePassword } from "@/modules/profile/actions";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

export function PasswordForm() {
  const t = useTranslations("profile");
  const tc = useTranslations("common");
  const [state, action] = useActionState(changePassword, null);
  return (
    <form action={action} className="space-y-4">
      <Field label={t("currentPassword")}>
        <Input type="password" name="current" required autoComplete="current-password" dir="ltr" />
      </Field>
      <Field label={t("newPassword")} error={state?.fieldErrors?.next}>
        <Input type="password" name="next" required minLength={10} autoComplete="new-password" dir="ltr" />
      </Field>
      <FormMessage state={state} />
      <SubmitButton>{tc("save")}</SubmitButton>
    </form>
  );
}

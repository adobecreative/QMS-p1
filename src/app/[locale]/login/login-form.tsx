"use client";

import { startTransition, useActionState } from "react";
import { useTranslations } from "next-intl";
import { Field, FormMessage, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { loginAction } from "./actions";

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const t = useTranslations("login");
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="redirectTo" value={redirectTo} />
      <Field label={t("email")}>
        <Input name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label={t("password")}>
        <Input name="password" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      <FormMessage state={state} />
      <div className="[&>button]:w-full">
        <SubmitButton pending={pending}>{t("submit")}</SubmitButton>
      </div>
    </form>
  );
}

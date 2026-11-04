"use server";

import { AuthError } from "next-auth";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/core/auth/auth";
import type { ActionState } from "@/core/actions";

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const redirectTo = String(form.get("redirectTo") ?? "/");
    await signIn("credentials", {
      email: form.get("email"),
      password: form.get("password"),
      redirectTo: redirectTo.startsWith("/") ? redirectTo : "/",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) {
      const t = await getTranslations("login");
      return { ok: false, message: t("invalid") };
    }
    throw err; // NEXT_REDIRECT on success
  }
}

"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requireUser } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";

export async function setMyLocale(locale: "ar" | "en") {
  const user = await requireUser();
  await db.user.update({ where: { id: user.id }, data: { locale } });
  revalidatePath("/[locale]/profile", "page");
}

const passwordSchema = z.object({
  current: z.string().min(1),
  next: z.string().min(10).max(200),
});

export async function changePassword(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const t = await getTranslations("profile");
  const parsed = passwordSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error), message: (await getTranslations("common"))("error") };
  if (!user.passwordHash || !(await bcrypt.compare(parsed.data.current, user.passwordHash))) {
    return { ok: false, message: t("wrongPassword") };
  }
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(parsed.data.next, 12) } }),
    audit(db, { actorId: user.id, action: "user.change_password", entityType: "User", entityId: user.id }),
  ]);
  return { ok: true, message: t("passwordChanged") };
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requireUser } from "@/core/auth/session";
import { NOTIFICATION_TYPES } from "@/core/notifications/catalog";
import type { ActionState } from "@/core/actions";

export async function markAllRead() {
  const user = await requireUser();
  await db.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/[locale]/notifications", "page");
}

export async function markRead(id: string) {
  const user = await requireUser();
  await db.notification.updateMany({ where: { id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/[locale]/notifications", "page");
}

export async function savePreferences(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const t = await getTranslations("common");
  const types = Object.entries(NOTIFICATION_TYPES).filter(([, def]) => !("mandatory" in def && def.mandatory));
  await db.$transaction(
    types.map(([type]) =>
      db.notificationPreference.upsert({
        where: { userId_type: { userId: user.id, type } },
        create: { userId: user.id, type, inApp: form.has(`${type}:inApp`), email: form.has(`${type}:email`) },
        update: { inApp: form.has(`${type}:inApp`), email: form.has(`${type}:email`) },
      }),
    ),
  );
  revalidatePath("/[locale]/notifications/preferences", "page");
  return { ok: true, message: t("saved") };
}


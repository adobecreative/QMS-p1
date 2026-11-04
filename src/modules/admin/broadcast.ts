"use server";

import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { assertPermission } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { publish } from "@/core/events/bus";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";
import { optionalText, requiredText } from "@/core/validation";

const schema = z
  .object({
    titleAr: requiredText(200),
    titleEn: requiredText(200),
    bodyAr: optionalText(4000),
    bodyEn: optionalText(4000),
    severity: z.enum(["INFO", "SUCCESS", "WARNING", "CRITICAL"]),
    audience: z.enum(["all", "department", "role"]),
    departmentId: optionalText(),
    roleKey: optionalText(),
  })
  .refine((v) => v.audience !== "department" || v.departmentId, { path: ["departmentId"], message: "required" })
  .refine((v) => v.audience !== "role" || v.roleKey, { path: ["roleKey"], message: "required" });

export async function sendBroadcast(_prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("notifications.broadcast");
  const tc = await getTranslations("common");
  const t = await getTranslations("admin.broadcast");
  const parsed = schema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error"), fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const audience =
    v.audience === "all" ? { all: true } : v.audience === "department" ? { departmentIds: [v.departmentId!] } : { roleKeys: [v.roleKey!] };
  const bodyAr = v.bodyAr ?? v.bodyEn;
  const bodyEn = v.bodyEn ?? v.bodyAr;

  await db.$transaction(async (tx) => {
    const event = await publish(
      tx,
      "notification.broadcast_requested",
      {
        title: { ar: v.titleAr, en: v.titleEn },
        body: bodyAr && bodyEn ? { ar: bodyAr, en: bodyEn } : undefined,
        severity: v.severity,
        audience,
      },
      { actorId: actor.id },
    );
    await audit(tx, { actorId: actor.id, action: "notification.broadcast", entityType: "DomainEvent", entityId: event.id, details: { audience } });
  });
  return { ok: true, message: t("sent") };
}

"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { assertPermission } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";
import { optionalText, requiredText, stringList } from "@/core/validation";

const schema = z.object({
  id: optionalText(),
  key: requiredText(50).transform((v) => v.toUpperCase().replace(/[^A-Z0-9]+/g, "_")),
  nameEn: requiredText(),
  nameAr: requiredText(),
  descriptionEn: optionalText(),
  descriptionAr: optionalText(),
  permissions: stringList,
});

/** Create or edit a custom role. System roles are managed by the seed script. */
export async function saveRole(_prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("roles.manage");
  const tc = await getTranslations("common");
  const parsed = schema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error"), fieldErrors: fieldErrors(parsed.error) };
  const { id, ...data } = parsed.data;
  if (id) {
    const existing = await db.role.findUniqueOrThrow({ where: { id } });
    if (existing.isSystem) return { ok: false, message: tc("forbidden") };
  }
  try {
    await db.$transaction(async (tx) => {
      const role = id ? await tx.role.update({ where: { id }, data }) : await tx.role.create({ data });
      await audit(tx, { actorId: actor.id, action: id ? "role.update" : "role.create", entityType: "Role", entityId: role.id, details: { permissions: data.permissions } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, message: tc("error"), fieldErrors: { key: "duplicate" } };
    }
    throw err;
  }
  revalidatePath("/[locale]/admin/roles", "layout");
  return { ok: true, message: tc("saved") };
}

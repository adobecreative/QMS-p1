"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { assertPermission } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";
import { checkbox, optionalText, requiredText } from "@/core/validation";

const schema = z.object({
  id: optionalText(),
  code: requiredText(20).transform((v) => v.toUpperCase()),
  nameEn: requiredText(),
  nameAr: requiredText(),
  parentId: optionalText(),
  headId: optionalText(),
  isActive: checkbox,
});

export async function saveDepartment(_prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("departments.manage");
  const tc = await getTranslations("common");
  const parsed = schema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error"), fieldErrors: fieldErrors(parsed.error) };
  const { id, ...data } = parsed.data;
  if (id && data.parentId === id) return { ok: false, message: tc("error"), fieldErrors: { parentId: "≠ self" } };
  try {
    await db.$transaction(async (tx) => {
      const dep = id ? await tx.department.update({ where: { id }, data }) : await tx.department.create({ data });
      await audit(tx, { actorId: actor.id, action: id ? "department.update" : "department.create", entityType: "Department", entityId: dep.id, details: { code: dep.code } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, message: tc("error"), fieldErrors: { code: "duplicate" } };
    }
    throw err;
  }
  revalidatePath("/[locale]/admin/departments", "layout");
  return { ok: true, message: tc("saved") };
}

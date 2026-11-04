"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { assertPermission } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";
import { checkbox, commaList, optionalText, requiredText } from "@/core/validation";

const schema = z.object({
  id: optionalText(),
  code: requiredText(20).transform((v) => v.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9_]+$/)),
  nameEn: requiredText(),
  nameAr: requiredText(),
  descriptionEn: optionalText(2000),
  descriptionAr: optionalText(2000),
  jciCodes: commaList,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: requiredText(50),
  sortOrder: z.coerce.number().int().default(0),
  leadId: optionalText(),
  isActive: checkbox,
});

/** Saves a chapter. Setting a lead also gives them the CHAPTER_LEAD role scoped to it. */
export async function saveChapter(_prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("chapters.manage");
  const tc = await getTranslations("common");
  const parsed = schema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error"), fieldErrors: fieldErrors(parsed.error) };
  const { id, ...data } = parsed.data;
  try {
    await db.$transaction(async (tx) => {
      const chapter = id ? await tx.chapter.update({ where: { id }, data }) : await tx.chapter.create({ data });
      if (chapter.leadId) {
        const role = await tx.role.findUnique({ where: { key: "CHAPTER_LEAD" } });
        if (role) {
          const has = await tx.userRole.findFirst({ where: { userId: chapter.leadId, roleId: role.id, chapterId: chapter.id } });
          if (!has) await tx.userRole.create({ data: { userId: chapter.leadId, roleId: role.id, chapterId: chapter.id } });
        }
      }
      await audit(tx, {
        actorId: actor.id,
        action: id ? "chapter.update" : "chapter.create",
        entityType: "Chapter",
        entityId: chapter.id,
        chapterCode: chapter.code,
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, message: tc("error"), fieldErrors: { code: "duplicate" } };
    }
    throw err;
  }
  revalidatePath("/[locale]", "layout");
  return { ok: true, message: tc("saved") };
}

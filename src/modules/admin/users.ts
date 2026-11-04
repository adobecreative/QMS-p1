"use server";

import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { db } from "@/core/db";
import { assertPermission } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { publish } from "@/core/events/bus";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";
import { checkbox, optionalText, requiredText } from "@/core/validation";

const userSchema = z.object({
  id: optionalText(),
  email: z.string().trim().toLowerCase().email(),
  name: requiredText(),
  nameAr: optionalText(200),
  employeeNo: optionalText(50),
  jobTitle: optionalText(200),
  phone: optionalText(50),
  locale: z.enum(["ar", "en"]).default("ar"),
  departmentId: optionalText(),
  isActive: checkbox,
  password: z
    .string()
    .optional()
    .refine((v) => !v || v.length >= 10, { message: "min 10" }),
});

export async function saveUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("users.manage");
  const tc = await getTranslations("common");
  const parsed = userSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error"), fieldErrors: fieldErrors(parsed.error) };
  const { id, password, ...data } = parsed.data;
  const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;
  let newId: string | null = null;

  try {
    const user = await db.$transaction(async (tx) => {
      if (id) {
        const before = await tx.user.findUniqueOrThrow({ where: { id } });
        const updated = await tx.user.update({ where: { id }, data: { ...data, ...(passwordHash && { passwordHash }) } });
        await audit(tx, { actorId: actor.id, action: "user.update", entityType: "User", entityId: id, details: { email: data.email } });
        if (before.isActive && !updated.isActive) {
          await publish(tx, "user.deactivated", { userId: id }, { actorId: actor.id, entityType: "User", entityId: id });
        }
        return updated;
      }
      const created = await tx.user.create({ data: { ...data, passwordHash } });
      await audit(tx, { actorId: actor.id, action: "user.create", entityType: "User", entityId: created.id, details: { email: data.email } });
      await publish(tx, "user.created", { userId: created.id }, { actorId: actor.id, entityType: "User", entityId: created.id });
      return created;
    });
    revalidatePath("/[locale]/admin/users", "layout");
    if (!id) newId = user.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const t = await getTranslations("admin.users");
      return { ok: false, message: t("emailTaken") };
    }
    throw err;
  }
  // After creating, continue on the edit page to assign roles.
  if (newId) redirect(`/${await getLocale()}/admin/users/${newId}`);
  return { ok: true, message: tc("saved") };
}

const roleAssignmentSchema = z.object({
  roleId: requiredText(),
  departmentId: optionalText(),
  chapterId: optionalText(),
});

export async function addUserRole(userId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("users.manage");
  const tc = await getTranslations("common");
  const parsed = roleAssignmentSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error") };
  const exists = await db.userRole.findFirst({ where: { userId, ...parsed.data } });
  if (!exists) {
    await db.$transaction(async (tx) => {
      const ur = await tx.userRole.create({ data: { userId, ...parsed.data } });
      await audit(tx, { actorId: actor.id, action: "user.role_add", entityType: "User", entityId: userId, details: { userRoleId: ur.id, ...parsed.data } });
      await publish(tx, "user.roles_changed", { userId }, { actorId: actor.id, entityType: "User", entityId: userId });
    });
  }
  revalidatePath("/[locale]/admin/users/[id]", "page");
  return { ok: true, message: tc("saved") };
}

export async function removeUserRole(userRoleId: string) {
  const actor = await assertPermission("users.manage");
  await db.$transaction(async (tx) => {
    const ur = await tx.userRole.delete({ where: { id: userRoleId } });
    await audit(tx, { actorId: actor.id, action: "user.role_remove", entityType: "User", entityId: ur.userId, details: { roleId: ur.roleId } });
    await publish(tx, "user.roles_changed", { userId: ur.userId }, { actorId: actor.id, entityType: "User", entityId: ur.userId });
  });
  revalidatePath("/[locale]/admin/users/[id]", "page");
}

"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { assertPermission } from "@/core/auth/session";
import { audit } from "@/core/audit/audit";
import { API_SCOPES, generateApiKey } from "@/core/integrations/api-keys";
import { fieldErrors, formToObject, type ActionState } from "@/core/actions";
import { stringList } from "@/core/validation";

const schema = z.object({
  // Becomes part of event types: external.<name>.<event>
  name: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,30}$/),
  scopes: stringList.pipe(z.array(z.enum(Object.keys(API_SCOPES) as [string, ...string[]])).min(1)),
});

export async function createApiClient(_prev: ActionState, form: FormData): Promise<ActionState> {
  const actor = await assertPermission("integrations.manage");
  const tc = await getTranslations("common");
  const parsed = schema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: tc("error"), fieldErrors: fieldErrors(parsed.error) };
  const { key, prefix, keyHash } = generateApiKey();
  try {
    await db.$transaction(async (tx) => {
      const client = await tx.apiClient.create({ data: { ...parsed.data, keyPrefix: prefix, keyHash } });
      await audit(tx, { actorId: actor.id, action: "integration.create", entityType: "ApiClient", entityId: client.id, details: { name: client.name, scopes: client.scopes } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, message: tc("error"), fieldErrors: { name: "duplicate" } };
    }
    throw err;
  }
  revalidatePath("/[locale]/admin/integrations", "page");
  return { ok: true, data: { key } };
}

export async function toggleApiClient(id: string) {
  const actor = await assertPermission("integrations.manage");
  await db.$transaction(async (tx) => {
    const c = await tx.apiClient.findUniqueOrThrow({ where: { id } });
    await tx.apiClient.update({ where: { id }, data: { isActive: !c.isActive } });
    await audit(tx, { actorId: actor.id, action: c.isActive ? "integration.disable" : "integration.enable", entityType: "ApiClient", entityId: id });
  });
  revalidatePath("/[locale]/admin/integrations", "page");
}

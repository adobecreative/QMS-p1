import "server-only";
import { cache } from "react";
import { getLocale } from "next-intl/server";
import { db } from "@/core/db";
import { redirect } from "@/i18n/navigation";
import { can, canSomewhere, type Grant, type Scope } from "@/core/rbac/can";
import type { Permission } from "@/core/rbac/permissions";
import { auth } from "./auth";

export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`Forbidden: missing permission "${permission}"`);
    this.name = "ForbiddenError";
  }
}

/**
 * The signed-in user with their grants, loaded once per request.
 * Grants are read from the database on each request (not from the cookie), so
 * role changes apply immediately.
 */
export const getCurrentUser = cache(async () => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await db.user.findUnique({
    where: { id },
    include: {
      department: true,
      roles: { include: { role: true, chapter: { select: { code: true } } } },
    },
  });
  if (!user?.isActive) return null;
  const grants: Grant[] = user.roles.map((r) => ({
    permissions: r.role.permissions,
    departmentId: r.departmentId,
    chapterCode: r.chapter?.code ?? null,
  }));
  return {
    ...user,
    grants,
    can: (permission: Permission, scope?: Scope) => can(grants, permission, scope),
    canSomewhere: (permission: Permission) => canSomewhere(grants, permission),
  };
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** For pages: redirect to the login page when nobody is signed in. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const locale = await getLocale();
    return redirect({ href: "/login", locale });
  }
  return user;
}

/** For pages: show the "no access" page when the permission is missing. */
export async function requirePermission(permission: Permission, scope?: Scope): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.can(permission, scope)) {
    const locale = await getLocale();
    return redirect({ href: "/forbidden", locale });
  }
  return user;
}

/** For server actions and API routes: throw instead of redirecting. */
export async function assertPermission(permission: Permission, scope?: Scope): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new ForbiddenError("signed-in user");
  if (!user.can(permission, scope)) throw new ForbiddenError(permission);
  return user;
}

import type { Db } from "@/core/db";

/**
 * Who should receive a notification. All parts are combined (union).
 * Only active users are returned.
 */
export type Audience = {
  all?: boolean;
  userIds?: string[];
  /** Users holding one of these roles (any scope). */
  roleKeys?: string[];
  /** Members of these departments (by id). */
  departmentIds?: string[];
  /** Heads of these departments (by id). */
  departmentHeadsOf?: string[];
  /** Leads of these chapters (by code). */
  chapterLeadsOf?: string[];
};

export async function resolveAudience(client: Db, audience: Audience): Promise<string[]> {
  if (audience.all) {
    const users = await client.user.findMany({ where: { isActive: true }, select: { id: true } });
    return users.map((u) => u.id);
  }

  const or: object[] = [];
  if (audience.userIds?.length) or.push({ id: { in: audience.userIds } });
  if (audience.roleKeys?.length) or.push({ roles: { some: { role: { key: { in: audience.roleKeys } } } } });
  if (audience.departmentIds?.length) or.push({ departmentId: { in: audience.departmentIds } });
  if (audience.departmentHeadsOf?.length)
    or.push({ headOfDepartments: { some: { id: { in: audience.departmentHeadsOf } } } });
  if (audience.chapterLeadsOf?.length)
    or.push({ leadOfChapters: { some: { code: { in: audience.chapterLeadsOf } } } });
  if (!or.length) return [];

  const users = await client.user.findMany({
    where: { isActive: true, OR: or },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

import type { Permission } from "./permissions";

/**
 * Pure authorisation logic — no database access, so it is trivial to test.
 *
 * A user holds grants. Each grant is a role's permission list plus an optional
 * scope. A grant without scope applies everywhere; a grant scoped to a
 * department/chapter only applies to records in that department/chapter.
 */
export type Grant = {
  permissions: string[];
  departmentId?: string | null;
  chapterCode?: string | null;
};

export type Scope = {
  departmentId?: string | null;
  chapterCode?: string | null;
};

export function permissionMatches(granted: string, wanted: string): boolean {
  if (granted === "*" || granted === wanted) return true;
  if (granted.endsWith(".*")) return wanted.startsWith(granted.slice(0, -1));
  return false;
}

function scopeMatches(grant: Grant, scope?: Scope): boolean {
  if (grant.departmentId && grant.departmentId !== scope?.departmentId) return false;
  if (grant.chapterCode && grant.chapterCode !== scope?.chapterCode) return false;
  return true;
}

/**
 * can(grants, "documents.approve")                        → only hospital-wide grants count
 * can(grants, "documents.approve", { chapterCode: "IPC" }) → hospital-wide grants, or grants scoped to IPC
 *
 * When `scope` is omitted only hospital-wide grants count, which is the safe
 * default for global screens.
 */
export function can(grants: Grant[], permission: Permission, scope?: Scope): boolean {
  return grants.some(
    (g) => scopeMatches(g, scope) && g.permissions.some((p) => permissionMatches(p, permission)),
  );
}

/**
 * True when the user holds the permission in at least one scope. Use it to
 * decide whether to show a menu entry; then filter the data with `can(..., scope)`.
 */
export function canSomewhere(grants: Grant[], permission: Permission): boolean {
  return grants.some((g) => g.permissions.some((p) => permissionMatches(p, permission)));
}

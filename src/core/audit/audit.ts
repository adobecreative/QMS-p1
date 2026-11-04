import type { Prisma } from "@prisma/client";
import type { Db } from "@/core/db";

export type AuditEntry = {
  actorId?: string | null;
  action: string; // e.g. "user.update", "document.approve"
  entityType: string;
  entityId?: string | null;
  chapterCode?: string | null;
  details?: Prisma.InputJsonValue;
};

/** Append a line to the audit trail. Call it inside the same transaction as the change. */
export function audit(client: Db, entry: AuditEntry) {
  return client.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      chapterCode: entry.chapterCode ?? null,
      details: entry.details,
    },
  });
}

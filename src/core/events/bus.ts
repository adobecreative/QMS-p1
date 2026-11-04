import type { Prisma } from "@prisma/client";
import type { Db } from "@/core/db";
import { eventSchemas, type EventPayload, type EventType } from "./catalog";

export type EventMeta = {
  actorId?: string | null;
  chapterCode?: string | null;
  entityType?: string;
  entityId?: string;
};

/**
 * Publish an internal event.
 *
 * Pass the transaction you used for the change itself, so the event is saved
 * if — and only if — the change is saved (transactional outbox):
 *
 *   await db.$transaction(async (tx) => {
 *     const incident = await tx.incident.create({ ... });
 *     await publish(tx, "incident.reported", { incidentId: incident.id }, { actorId });
 *   });
 *
 * The worker then delivers it to every subscriber (src/core/events/subscribers.ts).
 */
export async function publish<T extends EventType>(
  client: Db,
  type: T,
  payload: EventPayload<T>,
  meta: EventMeta = {},
) {
  const data = eventSchemas[type].parse(payload) as Prisma.InputJsonValue;
  return client.domainEvent.create({
    data: {
      type,
      payload: data,
      actorId: meta.actorId ?? null,
      chapterCode: meta.chapterCode ?? null,
      entityType: meta.entityType,
      entityId: meta.entityId,
    },
  });
}

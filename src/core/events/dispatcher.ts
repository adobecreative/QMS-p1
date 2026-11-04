import type { DomainEvent } from "@prisma/client";
import { db } from "@/core/db";
import { handlersFor } from "./registry";

export const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 300;

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 1h. */
export function backoffSeconds(attempt: number) {
  return Math.min(30 * 2 ** (attempt - 1), 3600);
}

/**
 * Claim up to `limit` due events and run their subscribers.
 *
 * Claiming moves `availableAt` forward (a lease), using SKIP LOCKED so several
 * workers can run side by side without processing the same event twice.
 * Returns the number of events processed.
 */
export async function dispatchBatch(limit = 50): Promise<number> {
  const claimed = await db.$queryRaw<DomainEvent[]>`
    UPDATE "DomainEvent"
       SET "availableAt" = now() + make_interval(secs => ${LEASE_SECONDS}),
           "attempts" = "attempts" + 1
     WHERE "id" IN (
       SELECT "id" FROM "DomainEvent"
        WHERE "status" = 'PENDING' AND "availableAt" <= now()
        ORDER BY "occurredAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING *`;

  for (const event of claimed) {
    await dispatchOne(event);
  }
  return claimed.length;
}

async function dispatchOne(event: DomainEvent) {
  try {
    for (const sub of handlersFor(event.type)) {
      await sub.handler(event);
    }
    await db.domainEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const failed = event.attempts >= MAX_ATTEMPTS;
    await db.domainEvent.update({
      where: { id: event.id },
      data: {
        status: failed ? "FAILED" : "PENDING",
        lastError: message.slice(0, 2000),
        availableAt: new Date(Date.now() + backoffSeconds(event.attempts) * 1000),
      },
    });
    console.error(`[events] ${event.type} ${event.id} attempt ${event.attempts} failed: ${message}`);
  }
}

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/core/db";
import { authenticateApiRequest } from "@/core/integrations/api-keys";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Event name inside the client's namespace, e.g. "work_order.overdue". */
  type: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "lowercase dotted name, e.g. work_order.overdue"),
  /** Idempotency key from the sending system; re-sending the same id is a no-op. */
  externalId: z.string().min(1).max(200),
  occurredAt: z.coerce.date().optional(),
  chapterCode: z.string().max(20).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(200).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/**
 * POST /api/v1/events — connected systems publish events into QMS.
 * The stored type is "external.<client name>.<type>". See docs/integrations.md.
 */
export async function POST(request: Request) {
  const client = await authenticateApiRequest(request, "events:write");
  if (!client) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const source = client.name;
  const type = `external.${source}.${body.type}`;

  try {
    const event = await db.domainEvent.create({
      data: {
        type,
        source,
        externalId: body.externalId,
        payload: body.payload as Prisma.InputJsonValue,
        chapterCode: body.chapterCode,
        entityType: body.entityType,
        entityId: body.entityId,
        occurredAt: body.occurredAt ?? new Date(),
      },
    });
    return Response.json({ id: event.id, type, status: "accepted" }, { status: 202 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.domainEvent.findUnique({
        where: { source_externalId: { source, externalId: body.externalId } },
      });
      return Response.json({ id: existing?.id, type, status: "duplicate" }, { status: 200 });
    }
    throw err;
  }
}

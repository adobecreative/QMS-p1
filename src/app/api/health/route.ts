import { db } from "@/core/db";

export const dynamic = "force-dynamic";

/** Liveness + database check for load balancers and the portal. */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const pending = await db.domainEvent.count({ where: { status: "PENDING" } });
    return Response.json({ status: "ok", database: "ok", pendingEvents: pending });
  } catch {
    return Response.json({ status: "error", database: "unreachable" }, { status: 503 });
  }
}

import { auth } from "@/core/auth/auth";
import { db } from "@/core/db";

export const dynamic = "force-dynamic";

/** Used by the bell in the header (polled every 30 s). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });
  const where = { userId: session.user.id, readAt: null };
  const [count, latest] = await Promise.all([
    db.notification.count({ where }),
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, title: true, link: true, severity: true, createdAt: true },
    }),
  ]);
  return Response.json({ count, latest });
}

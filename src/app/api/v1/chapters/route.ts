import { db } from "@/core/db";
import { authenticateApiRequest } from "@/core/integrations/api-keys";

export const dynamic = "force-dynamic";

/** GET /api/v1/chapters — reference data for the portal and other systems. */
export async function GET(request: Request) {
  const client = await authenticateApiRequest(request, "reference:read");
  if (!client) return Response.json({ error: "unauthorized" }, { status: 401 });
  const chapters = await db.chapter.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: { code: true, nameEn: true, nameAr: true, jciCodes: true, color: true },
  });
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  return Response.json({
    data: chapters.map((c) => ({ ...c, url: { ar: `${base}/ar/chapters/${c.code}`, en: `${base}/en/chapters/${c.code}` } })),
  });
}

import { db } from "@/core/db";
import { authenticateApiRequest } from "@/core/integrations/api-keys";

export const dynamic = "force-dynamic";

/** GET /api/v1/departments — reference data for connected systems. */
export async function GET(request: Request) {
  const client = await authenticateApiRequest(request, "reference:read");
  if (!client) return Response.json({ error: "unauthorized" }, { status: 401 });
  const departments = await db.department.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, nameEn: true, nameAr: true, parent: { select: { code: true } } },
  });
  return Response.json({
    data: departments.map(({ parent, ...d }) => ({ ...d, parentCode: parent?.code ?? null })),
  });
}

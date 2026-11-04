import { db } from "@/core/db";

let n = 0;
export async function makeUser(data: { roleKey?: string; departmentId?: string; locale?: "ar" | "en" } = {}) {
  n++;
  const user = await db.user.create({
    data: { email: `u${n}-${Date.now()}@test.local`, name: `User ${n}`, locale: data.locale ?? "en", departmentId: data.departmentId },
  });
  if (data.roleKey) {
    const role = await db.role.upsert({
      where: { key: data.roleKey },
      create: { key: data.roleKey, nameEn: data.roleKey, nameAr: data.roleKey, permissions: [] },
      update: {},
    });
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user;
}

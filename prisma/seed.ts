/**
 * Idempotent seed: safe to run any number of times (`npm run db:seed`).
 * Creates chapters, departments, system roles and the first administrator.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { chapters } from "./seed-data/chapters";
import { departments } from "./seed-data/departments";
import { roles } from "./seed-data/roles";

const db = new PrismaClient();

async function main() {
  for (const [i, c] of chapters.entries()) {
    await db.chapter.upsert({
      where: { code: c.code },
      create: { ...c, sortOrder: i },
      update: {},
    });
  }

  for (const d of departments.filter((d) => !d.parent)) {
    await db.department.upsert({ where: { code: d.code }, create: { code: d.code, nameEn: d.nameEn, nameAr: d.nameAr }, update: {} });
  }
  for (const d of departments.filter((d) => d.parent)) {
    const parent = await db.department.findUniqueOrThrow({ where: { code: d.parent! } });
    await db.department.upsert({
      where: { code: d.code },
      create: { code: d.code, nameEn: d.nameEn, nameAr: d.nameAr, parentId: parent.id },
      update: {},
    });
  }

  for (const r of roles) {
    await db.role.upsert({
      where: { key: r.key },
      create: { ...r, isSystem: true },
      update: { permissions: r.permissions, nameEn: r.nameEn, nameAr: r.nameAr, isSystem: true },
    });
  }

  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@hospital.local").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";
  const adminRole = await db.role.findUniqueOrThrow({ where: { key: "SYSTEM_ADMIN" } });
  const qps = await db.department.findUniqueOrThrow({ where: { code: "QPS" } });
  const admin = await db.user.upsert({
    where: { email },
    create: {
      email,
      name: "System Administrator",
      nameAr: "مدير النظام",
      passwordHash: await bcrypt.hash(password, 12),
      departmentId: qps.id,
    },
    update: {},
  });
  const hasAdminRole = await db.userRole.findFirst({ where: { userId: admin.id, roleId: adminRole.id } });
  if (!hasAdminRole) await db.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  console.info(`Seed complete: ${chapters.length} chapters, ${departments.length} departments, ${roles.length} roles.`);
  console.info(`Administrator: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

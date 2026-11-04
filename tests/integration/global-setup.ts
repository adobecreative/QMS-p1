import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/** Applies migrations to the test database and empties it before the run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://qms:qms@localhost:5432/qms_test?schema=public";
  if (!/test/i.test(url)) throw new Error("TEST_DATABASE_URL must point at a database whose name contains 'test'");
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  const db = new PrismaClient({ datasourceUrl: url });
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  }
  await db.$disconnect();
}

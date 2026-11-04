import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * One PrismaClient per process. In dev, Next.js hot-reload would otherwise
 * create a new client (and connection pool) on every change.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/** A Prisma client or an open transaction — services accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

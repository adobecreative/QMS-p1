import { db } from "@/core/db";
import { defineJob } from "./scheduler";

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

export const foundationJobs = [
  defineJob({
    name: "events.cleanup",
    everyMinutes: 24 * 60,
    async run() {
      const { count } = await db.domainEvent.deleteMany({
        where: { status: "PROCESSED", processedAt: { lt: days(90) } },
      });
      return `deleted ${count} processed events`;
    },
  }),
  defineJob({
    name: "notifications.cleanup",
    everyMinutes: 24 * 60,
    async run() {
      const { count } = await db.notification.deleteMany({
        where: { readAt: { lt: days(180) } },
      });
      return `deleted ${count} old read notifications`;
    },
  }),
];

import { db } from "@/core/db";

/**
 * Minimal scheduler for periodic jobs (expiry scans, reminders, clean-ups).
 * Each job runs at most once per interval across all worker instances: the
 * JobRun row is claimed with a conditional update.
 */
export type Job = {
  name: string;
  everyMinutes: number;
  run: () => Promise<void | string>;
};

export function defineJob(job: Job): Job {
  return job;
}

export async function runDueJobs(jobs: Job[], now = new Date()) {
  for (const job of jobs) {
    await db.jobRun.upsert({
      where: { name: job.name },
      create: { name: job.name, lastRunAt: new Date(0), lastStatus: "NEVER" },
      update: {},
    });
    const due = new Date(now.getTime() - job.everyMinutes * 60_000);
    const claim = await db.jobRun.updateMany({
      where: { name: job.name, lastRunAt: { lte: due } },
      data: { lastRunAt: now, lastStatus: "RUNNING" },
    });
    if (claim.count !== 1) continue;

    try {
      const result = await job.run();
      await db.jobRun.update({
        where: { name: job.name },
        data: { lastStatus: "OK", lastError: result ? String(result).slice(0, 500) : null },
      });
    } catch (err) {
      console.error(`[jobs] ${job.name} failed`, err);
      await db.jobRun.update({
        where: { name: job.name },
        data: { lastStatus: "FAILED", lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000) },
      });
    }
  }
}

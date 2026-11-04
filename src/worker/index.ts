/**
 * QMS worker — run with `npm run worker` (a separate process next to the web app).
 *
 *   1. dispatches domain events to subscribers   (src/core/events)
 *   2. sends queued e-mail notifications          (src/core/notifications)
 *   3. runs scheduled jobs: expiry scans, reminders, clean-ups (src/worker/jobs.ts)
 */
import "@/core/events/subscribers";
import { db } from "@/core/db";
import { dispatchBatch } from "@/core/events/dispatcher";
import { sendPendingEmails } from "@/core/notifications/deliver";
import { runDueJobs } from "@/core/jobs/scheduler";
import { jobs } from "./jobs";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
const JOBS_EVERY_MS = 60_000;

let running = true;
let lastJobsAt = 0;

async function tick() {
  let events = 0;
  do {
    events = await dispatchBatch(50);
  } while (events === 50 && running);
  await sendPendingEmails(25);
  if (Date.now() - lastJobsAt >= JOBS_EVERY_MS) {
    lastJobsAt = Date.now();
    await runDueJobs(jobs);
  }
}

async function main() {
  console.info(`[worker] started (poll ${POLL_MS}ms, ${jobs.length} scheduled jobs)`);
  while (running) {
    try {
      await tick();
    } catch (err) {
      console.error("[worker] tick failed", err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await db.$disconnect();
  console.info("[worker] stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

void main();

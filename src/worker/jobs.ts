import { foundationJobs } from "@/core/jobs/foundation-jobs";
import type { Job } from "@/core/jobs/scheduler";

/** Every periodic job. Each module appends its jobs here in its PR. */
export const jobs: Job[] = [...foundationJobs];

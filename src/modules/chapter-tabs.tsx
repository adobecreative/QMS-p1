import type { ComponentType } from "react";
import type { Chapter } from "@prisma/client";
import type { CurrentUser } from "@/core/auth/session";
import { OverviewTab } from "./chapters/overview-tab";

/**
 * Chapter tab key → component. Tab metadata lives in src/core/chapters/tabs.ts.
 * A module PR adds one line here and sets `ready: true` on its tab.
 * Components are async server components receiving the chapter and the user.
 */
export type ChapterTabProps = { chapter: Chapter; user: CurrentUser; locale: string };

export const chapterTabComponents: Record<string, ComponentType<ChapterTabProps>> = {
  overview: OverviewTab,
};

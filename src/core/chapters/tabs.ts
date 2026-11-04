import type { Bilingual } from "@/core/i18n";

/**
 * The unified chapter template: every chapter opens with the same tabs, and
 * each tab shows data from a shared engine filtered on that chapter.
 *
 * `module` names the engine that fills the tab. While a module is not built
 * yet the tab shows a "coming soon" notice. A module PR flips `ready` to true
 * and registers its component in src/modules/chapter-tabs.tsx.
 */
export type ChapterTab = {
  key: string;
  label: Bilingual;
  icon: string;
  module: string;
  ready: boolean;
};

export const CHAPTER_TABS: ChapterTab[] = [
  { key: "overview", label: { ar: "نظرة عامة", en: "Overview" }, icon: "LayoutDashboard", module: "foundation", ready: true },
  { key: "standards", label: { ar: "المعايير", en: "Standards" }, icon: "ListChecks", module: "standards", ready: false },
  { key: "documents", label: { ar: "السياسات والوثائق", en: "Policies & documents" }, icon: "FileText", module: "documents", ready: false },
  { key: "people", label: { ar: "الموظفون والكفاءات", en: "Staff & competency" }, icon: "Users", module: "people", ready: false },
  { key: "meetings", label: { ar: "اللجان والاجتماعات", en: "Committees & meetings" }, icon: "CalendarDays", module: "committees", ready: false },
  { key: "kpis", label: { ar: "المؤشرات", en: "KPIs" }, icon: "TrendingUp", module: "kpis", ready: false },
  { key: "improvement", label: { ar: "الحوادث والتحسين", en: "Incidents & improvement" }, icon: "ShieldAlert", module: "incidents", ready: false },
];

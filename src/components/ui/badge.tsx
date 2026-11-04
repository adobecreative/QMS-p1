import type { ReactNode } from "react";
import { cn } from "./cn";

const tones = {
  slate: "bg-slate-100 text-slate-700",
  green: "bg-green-50 text-green-700 ring-green-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  blue: "bg-blue-50 text-blue-700 ring-blue-600/20",
  brand: "bg-brand-50 text-brand-800 ring-brand-600/20",
};
export type BadgeTone = keyof typeof tones;

export const severityTone: Record<string, BadgeTone> = {
  INFO: "blue",
  SUCCESS: "green",
  WARNING: "amber",
  CRITICAL: "red",
};

export function Badge({ tone = "slate", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent", tones[tone], className)}>
      {children}
    </span>
  );
}

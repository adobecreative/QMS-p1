"use client";

import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Languages } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LocaleSwitcher({ label }: { label: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const next = locale === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      onClick={() => {
        const qs = search.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { locale: next });
      }}
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
    >
      <Languages className="size-4" aria-hidden />
      {label}
    </button>
  );
}

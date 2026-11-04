"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { Bell } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { cn } from "@/components/ui/cn";

type Item = { id: string; title: string; link: string | null; severity: string; createdAt: string };

const DOT: Record<string, string> = { INFO: "bg-blue-500", SUCCESS: "bg-green-500", WARNING: "bg-amber-500", CRITICAL: "bg-red-600" };
const POLL_MS = 30_000;

/** Header bell: unread count + latest items, refreshed every 30 seconds and on focus. */
export function NotificationBell() {
  const t = useTranslations("notifications");
  const format = useFormatter();
  const locale = useLocale();
  const now = useNow({ updateInterval: POLL_MS });
  const [data, setData] = useState<{ count: number; latest: Item[] }>({ count: 0, latest: [] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/notifications/unread", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100"
        aria-label={`${t("bell")} (${data.count})`}
      >
        <Bell className="size-5" aria-hidden />
        {data.count > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {data.count > 99 ? "99+" : data.count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 top-11 z-30 w-80 rounded-lg bg-white shadow-lg ring-1 ring-slate-200">
          <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold">{t("title")}</div>
          {data.latest.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">{t("empty")}</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {data.latest.map((n) => (
                <li key={n.id}>
                  {/* Plain <a>: a route handler that marks the item read — must not be prefetched. */}
                  <a href={`/${locale}/notifications/open/${n.id}`} className="flex gap-3 px-4 py-3 text-sm hover:bg-slate-50">
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[n.severity] ?? DOT.INFO)} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-800">{n.title}</span>
                      <span className="text-xs text-slate-500">{format.relativeTime(new Date(n.createdAt), now)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-slate-100 px-4 py-2.5 text-center text-sm text-brand-700 hover:bg-slate-50">
            {t("all")}
          </Link>
        </div>
      )}
    </div>
  );
}

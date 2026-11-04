"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/components/ui/cn";

export function NavLink({ href, icon, exact, children }: { href: string; icon?: React.ReactNode; exact?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 transition-colors",
        active ? "bg-brand-50 font-medium text-brand-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

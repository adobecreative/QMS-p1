import type { Chapter } from "@prisma/client";
import { pick } from "@/core/i18n";
import { Link } from "@/i18n/navigation";
import { Icon } from "@/components/ui/icon";

export function ChapterTile({ chapter, locale }: { chapter: Chapter; locale: string }) {
  return (
    <Link
      href={`/chapters/${chapter.code}`}
      className="group flex flex-col gap-3 rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md"
      style={{ borderTop: `4px solid ${chapter.color}` }}
    >
      <div className="flex items-center justify-between">
        <span className="flex size-10 items-center justify-center rounded-lg" style={{ background: `${chapter.color}1a`, color: chapter.color }}>
          <Icon name={chapter.icon} className="size-5" />
        </span>
        <span className="font-mono text-xs font-semibold text-slate-400">{chapter.code}</span>
      </div>
      <div>
        <h3 className="font-semibold text-slate-900 group-hover:text-brand-800">{pick(chapter, "name", locale)}</h3>
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{pick(chapter, "description", locale)}</p>
      </div>
      {chapter.jciCodes.length > 0 && (
        <p className="mt-auto text-[11px] text-slate-400">JCI · {chapter.jciCodes.join(" · ")}</p>
      )}
    </Link>
  );
}

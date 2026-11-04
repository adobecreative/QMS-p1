import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

export function EmptyState({ title, body, icon }: { title: ReactNode; body?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-slate-400">{icon ?? <Inbox className="size-8" aria-hidden />}</div>
      <p className="font-medium text-slate-800">{title}</p>
      {body && <p className="max-w-md text-sm text-slate-500">{body}</p>}
    </div>
  );
}

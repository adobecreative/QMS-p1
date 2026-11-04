import { getTranslations } from "next-intl/server";
import { Gauge } from "lucide-react";
import { db } from "@/core/db";
import { pick } from "@/core/i18n";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ChapterTabProps } from "../chapter-tabs";

export async function OverviewTab({ chapter, locale }: ChapterTabProps) {
  const t = await getTranslations("chapters");
  const [lead, team] = await Promise.all([
    chapter.leadId ? db.user.findUnique({ where: { id: chapter.leadId } }) : null,
    db.userRole.findMany({
      where: { chapterId: chapter.id },
      include: { user: true, role: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title={t("overviewAbout")} />
        <CardBody className="space-y-4 text-sm">
          <p className="leading-7 text-slate-700">{pick(chapter, "description", locale) || "—"}</p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-500">{t("lead")}</dt>
              <dd className="font-medium">{lead ? (locale === "ar" ? lead.nameAr || lead.name : lead.name) : t("noLead")}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{t("jci")}</dt>
              <dd className="flex flex-wrap gap-1">
                {chapter.jciCodes.length ? chapter.jciCodes.map((c) => <Badge key={c} tone="brand">{c}</Badge>) : "—"}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("readiness")} />
        <CardBody className="flex flex-col items-center gap-2 py-8 text-center">
          <Gauge className="size-10 text-slate-300" aria-hidden />
          <p className="text-sm text-slate-500">{t("readinessSoon")}</p>
        </CardBody>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader title={t("team")} />
        <CardBody>
          {team.length === 0 ? (
            <p className="text-sm text-slate-500">—</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {team.map((m) => (
                <li key={m.id} className="rounded-md bg-slate-50 px-3 py-1.5 text-sm ring-1 ring-slate-200">
                  {locale === "ar" ? m.user.nameAr || m.user.name : m.user.name}
                  <span className="ms-2 text-xs text-slate-500">{pick(m.role, "name", locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

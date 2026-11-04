import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requirePermission } from "@/core/auth/session";
import { t as tr } from "@/core/i18n";
import { API_SCOPES } from "@/core/integrations/api-keys";
import { toggleApiClient } from "@/modules/admin/integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { NewClientForm } from "./new-client-form";

export default async function IntegrationsPage() {
  await requirePermission("integrations.manage");
  const locale = await getLocale();
  const t = await getTranslations("admin.integrations");
  const tc = await getTranslations("common");
  const format = await getFormatter();
  const [clients, events] = await Promise.all([
    db.apiClient.findMany({ orderBy: { createdAt: "desc" } }),
    db.domainEvent.findMany({ where: { source: { not: "app" } }, orderBy: { occurredAt: "desc" }, take: 20 }),
  ]);
  const scopes = Object.entries(API_SCOPES).map(([key, label]) => ({ key, label: tr(label, locale) }));

  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <Table>
            <thead><tr><Th>{tc("name")}</Th><Th>{t("scopes")}</Th><Th>{t("lastUsed")}</Th><Th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {clients.map((c) => (
                <Tr key={c.id}>
                  <Td>
                    <span className="font-mono font-medium">{c.name}</span>
                    <span className="ms-2 font-mono text-xs text-slate-400">qms_{c.keyPrefix}_…</span>
                    {!c.isActive && <Badge className="ms-2">{tc("inactive")}</Badge>}
                  </Td>
                  <Td className="font-mono text-xs">{c.scopes.join(", ")}</Td>
                  <Td className="text-xs">{c.lastUsedAt ? format.relativeTime(c.lastUsedAt) : tc("none")}</Td>
                  <Td className="text-end">
                    <form action={toggleApiClient.bind(null, c.id)}>
                      <Button type="submit" size="sm" variant="ghost">{c.isActive ? t("revoke") : t("enable")}</Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title={t("new")} />
          <CardBody><NewClientForm scopes={scopes} /></CardBody>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader title={t("recentEvents")} />
          <Table>
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <Tr key={e.id}>
                  <Td className="font-mono text-xs">{e.type}</Td>
                  <Td className="text-xs">{e.chapterCode ?? ""}</Td>
                  <Td><Badge tone={e.status === "PROCESSED" ? "green" : e.status === "FAILED" ? "red" : "amber"}>{e.status}</Badge></Td>
                  <Td className="text-xs">{format.dateTime(e.occurredAt, { dateStyle: "short", timeStyle: "short" })}</Td>
                  <Td className="max-w-xs truncate text-xs text-red-700">{e.lastError}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}

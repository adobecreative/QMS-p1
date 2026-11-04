import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/core/db";
import { requireUser } from "@/core/auth/session";
import { NOTIFICATION_TYPES, type NotificationTypeDef } from "@/core/notifications/catalog";
import { t as tr } from "@/core/i18n";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PreferencesForm } from "./preferences-form";

export default async function PreferencesPage() {
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("notifications");
  const prefs = await db.notificationPreference.findMany({ where: { userId: user.id } });
  const byType = new Map(prefs.map((p) => [p.type, p]));

  const rows = Object.entries(NOTIFICATION_TYPES as Record<string, NotificationTypeDef>).map(([type, def]) => ({
    type,
    label: tr(def.label, locale),
    mandatory: Boolean(def.mandatory),
    inApp: def.mandatory ? true : (byType.get(type)?.inApp ?? def.defaults.inApp),
    email: def.mandatory ? true : (byType.get(type)?.email ?? def.defaults.email),
  }));

  return (
    <>
      <PageHeader title={t("preferencesTitle")} description={t("preferencesIntro")} />
      <Card>
        <PreferencesForm rows={rows} />
      </Card>
    </>
  );
}

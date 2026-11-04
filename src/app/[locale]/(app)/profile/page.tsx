import { getLocale, getTranslations } from "next-intl/server";
import { requireUser } from "@/core/auth/session";
import { pick } from "@/core/i18n";
import { setMyLocale } from "@/modules/profile/actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PasswordForm } from "./password-form";

export default async function ProfilePage() {
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("profile");
  const tc = await getTranslations("common");

  return (
    <>
      <PageHeader title={t("title")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={locale === "ar" ? user.nameAr || user.name : user.name} subtitle={user.email} />
          <CardBody className="space-y-4 text-sm">
            <p>
              <span className="text-slate-500">{tc("department")}: </span>
              {user.department ? pick(user.department, "name", locale) : tc("none")}
            </p>
            <div>
              <p className="mb-2 font-medium">{t("roles")}</p>
              {user.roles.length === 0 ? (
                <p className="text-slate-500">{t("noRoles")}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {user.roles.map((r) => (
                    <li key={r.id}>
                      <Badge tone="brand">
                        {pick(r.role, "name", locale)}
                        {r.chapter && ` · ${r.chapter.code}`}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 font-medium">{t("language")}</p>
              <div className="flex gap-2">
                {(["ar", "en"] as const).map((l) => (
                  <form key={l} action={setMyLocale.bind(null, l)}>
                    <Button type="submit" size="sm" variant={user.locale === l ? "primary" : "secondary"}>
                      {l === "ar" ? "العربية" : "English"}
                    </Button>
                  </form>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>
        {user.passwordHash && (
          <Card>
            <CardHeader title={t("changePassword")} />
            <CardBody>
              <PasswordForm />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}

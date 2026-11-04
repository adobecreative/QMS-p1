import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import { ssoEnabled, signIn } from "@/core/auth/auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { locale } = await params;
  const { callbackUrl } = await searchParams;
  const t = await getTranslations("login");
  const tApp = await getTranslations("app");
  const redirectTo = callbackUrl?.startsWith("/") ? callbackUrl : `/${locale}`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 to-brand-700 p-4">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <ShieldCheck className="mb-2 size-10 text-brand-700" aria-hidden />
          <h1 className="text-xl font-bold">{tApp("name")}</h1>
          <p className="text-sm text-slate-500">{tApp("hospital")}</p>
        </div>
        <h2 className="mb-1 text-lg font-semibold">{t("title")}</h2>
        <p className="mb-4 text-sm text-slate-500">{t("subtitle")}</p>
        <LoginForm redirectTo={redirectTo} />
        {ssoEnabled && (
          <>
            <div className="my-4 text-center text-xs text-slate-400">{t("or")}</div>
            <form
              action={async () => {
                "use server";
                await signIn("microsoft-entra-id", { redirectTo });
              }}
            >
              <Button type="submit" variant="secondary" className="w-full">
                {t("sso")}
              </Button>
            </form>
          </>
        )}
      </Card>
    </main>
  );
}

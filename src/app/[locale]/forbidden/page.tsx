import { getTranslations } from "next-intl/server";
import { Lock } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { buttonClass } from "@/components/ui/button";

export default async function ForbiddenPage() {
  const t = await getTranslations("forbidden");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <Lock className="size-10 text-slate-400" aria-hidden />
      <h1 className="text-xl font-bold">{t("title")}</h1>
      <p className="max-w-md text-slate-600">{t("body")}</p>
      <Link href="/" className={buttonClass("secondary")}>
        {t("home")}
      </Link>
    </main>
  );
}

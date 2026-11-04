import type { Chapter, User } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";

export async function ChapterFields({ chapter, users }: { chapter?: Chapter; users: User[] }) {
  const locale = await getLocale();
  const t = await getTranslations("admin.chapters");
  const tc = await getTranslations("common");
  const tch = await getTranslations("chapters");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {chapter && <input type="hidden" name="id" value={chapter.id} />}
      <Field label={tc("code")}><Input name="code" required dir="ltr" defaultValue={chapter?.code} /></Field>
      <Field label={t("jciCodes")}><Input name="jciCodes" dir="ltr" defaultValue={chapter?.jciCodes.join(", ")} /></Field>
      <Field label={tc("nameAr")}><Input name="nameAr" required defaultValue={chapter?.nameAr} /></Field>
      <Field label={tc("nameEn")}><Input name="nameEn" required defaultValue={chapter?.nameEn} /></Field>
      <Field label={t("descriptionAr")}><Textarea name="descriptionAr" defaultValue={chapter?.descriptionAr ?? ""} /></Field>
      <Field label={t("descriptionEn")}><Textarea name="descriptionEn" defaultValue={chapter?.descriptionEn ?? ""} /></Field>
      <Field label={t("color")}><Input name="color" type="color" defaultValue={chapter?.color ?? "#0f766e"} className="h-10 p-1" /></Field>
      <Field label={t("icon")} hint="lucide.dev/icons"><Input name="icon" dir="ltr" defaultValue={chapter?.icon ?? "BookOpen"} /></Field>
      <Field label={t("sortOrder")}><Input name="sortOrder" type="number" defaultValue={chapter?.sortOrder ?? 0} /></Field>
      <Field label={tch("lead")}>
        <Select name="leadId" defaultValue={chapter?.leadId ?? ""}>
          <option value="">{tch("noLead")}</option>
          {users.map((u) => <option key={u.id} value={u.id}>{locale === "ar" ? u.nameAr || u.name : u.name}</option>)}
        </Select>
      </Field>
      <Checkbox name="isActive" label={tc("active")} defaultChecked={chapter?.isActive ?? true} />
    </div>
  );
}

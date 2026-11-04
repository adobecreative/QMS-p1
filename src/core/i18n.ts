/** Locale helpers shared by server code (UI code uses next-intl). */
export type AppLocale = "ar" | "en";

/** Pick the Arabic or English variant of a bilingual record (`nameAr`/`nameEn`). */
export function pick<T extends Record<string, unknown>>(
  record: T,
  field: string,
  locale: string,
): string {
  const ar = record[`${field}Ar`] as string | null | undefined;
  const en = record[`${field}En`] as string | null | undefined;
  return (locale === "ar" ? ar || en : en || ar) ?? "";
}

/** A bilingual string literal. */
export type Bilingual = { ar: string; en: string };

export function t(text: Bilingual, locale: string): string {
  return locale === "ar" ? text.ar : text.en;
}

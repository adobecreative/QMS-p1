import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["ar", "en"],
  defaultLocale: "ar",
});

export type Locale = (typeof routing.locales)[number];

export const rtlLocales: Locale[] = ["ar"];
export const dirOf = (locale: string) => (rtlLocales.includes(locale as Locale) ? "rtl" : "ltr");

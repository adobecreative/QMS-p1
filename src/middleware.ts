import NextAuth from "next-auth";
import createIntlMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import { authConfig } from "@/core/auth/auth.config";
import { routing } from "@/i18n/routing";

const { auth } = NextAuth(authConfig);
const intl = createIntlMiddleware(routing);

const PUBLIC_PATHS = ["/login"];

/**
 * 1. Adds the locale prefix (/ar, /en) via next-intl.
 * 2. Sends visitors without a session to the login page.
 * Fine-grained permission checks happen in pages and actions, not here.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const segments = pathname.split("/");
  const locale = routing.locales.includes(segments[1] as never) ? segments[1] : routing.defaultLocale;
  const rest = routing.locales.includes(segments[1] as never) ? `/${segments.slice(2).join("/")}` : pathname;
  const isPublic = PUBLIC_PATHS.some((p) => rest === p || rest.startsWith(`${p}/`));

  if (!req.auth && !isPublic) {
    const url = new URL(`/${locale}/login`, req.nextUrl.origin);
    if (rest !== "/") url.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return intl(req);
});

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};

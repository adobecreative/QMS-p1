import { NextResponse } from "next/server";
import { auth } from "@/core/auth/auth";
import { db } from "@/core/db";

/** /<locale>/notifications/open/<id> — marks the notification read and follows its link. */
export async function GET(request: Request, { params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const session = await auth();
  // Behind a proxy (or in the standalone server) request.url can carry an
  // internal host, so build the redirect from the forwarded headers.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const origin = host ? `${proto}://${host}` : new URL(request.url).origin;
  if (!session?.user?.id) return NextResponse.redirect(new URL(`/${locale}/login`, origin));

  const n = await db.notification.findFirst({ where: { id, userId: session.user.id } });
  if (!n) return NextResponse.redirect(new URL(`/${locale}/notifications`, origin));
  if (!n.readAt) await db.notification.update({ where: { id }, data: { readAt: new Date() } });

  if (n.link && /^https?:\/\//.test(n.link)) return NextResponse.redirect(n.link);
  const target = n.link ? `/${locale}${n.link.startsWith("/") ? n.link : `/${n.link}`}` : `/${locale}/notifications`;
  return NextResponse.redirect(new URL(target, origin));
}

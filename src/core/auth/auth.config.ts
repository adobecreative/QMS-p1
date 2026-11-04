import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe part of the Auth.js config (no database access). It is used by
 * the middleware to read the session cookie. Providers that touch the database
 * live in ./auth.ts.
 */
export const authConfig = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/ar/login" },
  trustHost: true,
  providers: [],
  callbacks: {
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = token.uid as string;
      return session;
    },
  },
} satisfies NextAuthConfig;

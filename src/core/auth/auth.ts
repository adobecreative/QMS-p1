import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import type { Provider } from "next-auth/providers";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/core/db";
import { authConfig } from "./auth.config";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const providers: Provider[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    async authorize(raw) {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) throw new CredentialsSignin();
      const user = await db.user.findUnique({ where: { email: parsed.data.email } });
      if (!user?.isActive || !user.passwordHash) throw new CredentialsSignin();
      const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
      if (!ok) throw new CredentialsSignin();
      return { id: user.id, email: user.email, name: user.name };
    },
  }),
];

// Optional single sign-on with the hospital's Microsoft 365 tenant.
if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID) {
  providers.push(
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    }),
  );
}

export const ssoEnabled = Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,
  callbacks: {
    ...authConfig.callbacks,
    /** SSO users must already exist (and be active) in QMS — no self-registration. */
    async signIn({ user, account }) {
      if (account?.provider === "credentials") return true;
      if (!user.email) return false;
      const existing = await db.user.findUnique({ where: { email: user.email.toLowerCase() } });
      return Boolean(existing?.isActive);
    },
    async jwt({ token, user, account }) {
      if (account && user) {
        const dbUser =
          account.provider === "credentials"
            ? { id: user.id! }
            : await db.user.findUnique({ where: { email: user.email!.toLowerCase() }, select: { id: true } });
        token.uid = dbUser?.id;
        if (dbUser) await db.user.update({ where: { id: dbUser.id }, data: { lastLoginAt: new Date() } });
      }
      return token;
    },
  },
});

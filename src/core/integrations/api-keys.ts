import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/core/db";

/**
 * API keys for external systems (FMS, portal, HIS).
 * Format: qms_<prefix>_<secret>. Only a SHA-256 hash is stored; the full key
 * is shown once when it is created.
 */
export const API_SCOPES = {
  "events:write": { ar: "إرسال أحداث وتنبيهات", en: "Send events and alerts" },
  "reference:read": { ar: "قراءة الفصول والأقسام", en: "Read chapters and departments" },
} as const;
export type ApiScope = keyof typeof API_SCOPES;

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

export function generateApiKey() {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  return { prefix, key: `qms_${prefix}_${secret}`, keyHash: hash(secret) };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const m = /^qms_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/.exec(key.trim());
  return m ? { prefix: m[1], secret: m[2] } : null;
}

/** Returns the client when the Authorization header holds a valid key with the scope. */
export async function authenticateApiRequest(request: Request, scope: ApiScope) {
  const header = request.headers.get("authorization") ?? "";
  const parsed = parseApiKey(header.replace(/^Bearer\s+/i, ""));
  if (!parsed) return null;
  const client = await db.apiClient.findUnique({ where: { keyPrefix: parsed.prefix } });
  if (!client?.isActive || !client.scopes.includes(scope)) return null;
  const a = Buffer.from(client.keyHash, "hex");
  const b = Buffer.from(hash(parsed.secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  await db.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } });
  return client;
}

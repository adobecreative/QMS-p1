import { z } from "zod";

/**
 * Event catalog — every internal event type and the shape of its payload.
 *
 * Naming: "<entity>.<past-tense-verb>", e.g. "incident.reported".
 * Each module adds its events here in its PR. External systems publish
 * "external.<client>.<name>" events through the API; those are not listed
 * here because their payload is defined by the sending system (see
 * docs/integrations.md), but they may carry the standard `alert` envelope.
 */

export const bilingualSchema = z.object({ ar: z.string().min(1), en: z.string().min(1) });

export const audienceSchema = z.object({
  all: z.boolean().optional(),
  userIds: z.array(z.string()).optional(),
  roleKeys: z.array(z.string()).optional(),
  departmentIds: z.array(z.string()).optional(),
  departmentHeadsOf: z.array(z.string()).optional(),
  chapterLeadsOf: z.array(z.string()).optional(),
});

/** Optional envelope an external event can carry to raise an alert in QMS. */
export const externalAlertSchema = z.object({
  severity: z.enum(["INFO", "SUCCESS", "WARNING", "CRITICAL"]).default("WARNING"),
  title: bilingualSchema,
  body: bilingualSchema.optional(),
  link: z.string().url().optional(),
  chapterCode: z.string().optional(),
  audience: audienceSchema.default({ roleKeys: ["QUALITY_DIRECTOR"] }),
});

export const eventSchemas = {
  // --- Foundation -------------------------------------------------------------
  "user.created": z.object({ userId: z.string() }),
  "user.roles_changed": z.object({ userId: z.string() }),
  "user.deactivated": z.object({ userId: z.string() }),
  "notification.broadcast_requested": z.object({
    title: bilingualSchema,
    body: bilingualSchema.optional(),
    link: z.string().optional(),
    severity: z.enum(["INFO", "SUCCESS", "WARNING", "CRITICAL"]).default("INFO"),
    audience: audienceSchema,
  }),
} as const;

export type EventType = keyof typeof eventSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof eventSchemas)[T]>;

export function isKnownEventType(type: string): type is EventType {
  return type in eventSchemas;
}

import type { DomainEvent } from "@prisma/client";

/**
 * In-process subscriber registry used by the worker.
 *
 * Patterns: an exact type ("user.created"), a prefix wildcard
 * ("external.fms.*") or "*" for everything.
 *
 * Handlers MUST be idempotent: an event is retried as a whole if any handler
 * fails. Use unique keys (e.g. Notification has @@unique([eventId, userId, type]))
 * or check-before-insert.
 */
export type EventHandler = (event: DomainEvent) => Promise<void>;

type Subscription = { pattern: string; name: string; handler: EventHandler };

const subscriptions: Subscription[] = [];

export function subscribe(pattern: string, name: string, handler: EventHandler) {
  if (subscriptions.some((s) => s.name === name)) return; // tolerate double import
  subscriptions.push({ pattern, name, handler });
}

export function matches(pattern: string, type: string) {
  if (pattern === "*" || pattern === type) return true;
  return pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1));
}

export function handlersFor(type: string): Subscription[] {
  return subscriptions.filter((s) => matches(s.pattern, type));
}

/** Test helper. */
export function clearSubscriptions() {
  subscriptions.length = 0;
}

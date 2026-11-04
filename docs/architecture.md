# Architecture · المعمارية

## Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│  Portal (Aya Operation System)  →  deep links /ar/chapters/IPC          │
├───────────────────────────────────────────────────────────────────────┤
│  CHAPTERS (UI)   ESR · LD · QM · MM · FMS · IPC · NR · LB · MS · …     │
│  every chapter = the same 7 tabs (src/core/chapters/tabs.ts)            │
├───────────────────────────────────────────────────────────────────────┤
│  SHARED ENGINES (src/modules)                                           │
│  standards · documents · people · committees · incidents · CAPA ·       │
│  audits · KPIs                     (one module = one or more PRs)       │
├───────────────────────────────────────────────────────────────────────┤
│  FOUNDATION (src/core)                                                  │
│  users · departments · roles/RBAC · chapters · event bus ·              │
│  notifications · scheduler · audit trail · API keys                     │
├───────────────────────────────────────────────────────────────────────┤
│  EXTERNAL SYSTEMS  FMS · HIS · Power BI   ⇄  /api/v1                    │
└───────────────────────────────────────────────────────────────────────┘
```

Two processes run from the same code base:

| Process | Command | Does |
|---|---|---|
| **web** | `npm start` | pages, server actions, `/api` |
| **worker** | `npm run worker` | dispatches events, sends e-mails, runs scheduled jobs |

Both talk only to PostgreSQL. There is no Redis or message broker to operate.

## The tagging rule

Every module record that belongs to the quality system carries:

| Column | Example | Used for |
|---|---|---|
| `chapterCode` | `IPC` | shows the record on the chapter page, scopes chapter-lead permissions |
| `standardCode` | `IPC.12` | links evidence to standards and computes readiness |
| `departmentId` | Nursing | department filters, department-head permissions |

This is what lets a chapter page, a department view and the executive dashboard all read the same data without copies.

## Event bus (transactional outbox)

`publish(tx, type, payload, meta)` writes a `DomainEvent` row **in the same transaction** as the change:

```ts
await db.$transaction(async (tx) => {
  const incident = await tx.incident.create({ data });
  await publish(tx, "incident.reported", { incidentId: incident.id }, { actorId, chapterCode: "QM" });
});
```

The worker claims due events (`FOR UPDATE SKIP LOCKED`, so several workers are safe), runs every subscriber
registered for the type, and marks the event `PROCESSED`. If a subscriber throws, the whole event is retried with
exponential backoff (30 s → 1 h) and becomes `FAILED` after 8 attempts (visible in Admin → Integrations).

**Subscribers must be idempotent.** `notify()` is: it never notifies the same user twice for the same event.

- Event types and payload schemas: `src/core/events/catalog.ts`
- Subscribers are loaded from `src/core/events/subscribers.ts`
- Patterns: exact (`user.created`), prefix (`external.fms.*`) or `*`
- External systems publish `external.<client>.<name>` through `POST /api/v1/events`

## Notifications

```
event ─▶ subscriber ─▶ notify({ type, audience, title:{ar,en}, … })
                          │
                          ├─ resolveAudience: users / roles / departments / department heads / chapter leads
                          ├─ per-user preferences (unless the type is mandatory)
                          ├─ Notification row in the user's language  ─▶ bell + /notifications
                          └─ NotificationDelivery(EMAIL)               ─▶ worker sends via SMTP
```

- Types and default channels: `src/core/notifications/catalog.ts`
- Without `SMTP_HOST` e-mails are logged and marked `SKIPPED` — handy in development.
- The bell polls `/api/notifications/unread` every 30 s and on window focus.
- Scheduled alerts (e.g. "license expires in 30 days") are jobs in `src/worker/jobs.ts` that publish events or call `notify()`.

## Authorisation

- A **role** is a list of permission keys (`src/core/rbac/permissions.ts`). Wildcards: `*`, `documents.*`.
- A **user role** may be scoped to a department and/or a chapter. Unscoped = hospital-wide.
- `can(grants, "documents.approve", { chapterCode: "IPC" })` is pure and unit-tested.
- Pages use `requirePermission()`; server actions and API routes use `assertPermission()`.
- Grants are read from the database on every request, so role changes apply immediately.

## Authentication

Auth.js with a JWT session cookie (12 h). Credentials (bcrypt) always; Microsoft Entra ID (Microsoft 365) when
the `AUTH_MICROSOFT_ENTRA_ID_*` variables are set. SSO users must already exist in QMS (matched by e-mail) —
there is no self-registration.

## Internationalisation

All routes are prefixed with the locale (`/ar/...`, `/en/...`; Arabic is the default). UI strings live in
`messages/{ar,en}.json`. Database labels use `nameAr`/`nameEn` pairs, read with `pick(record, "name", locale)`.
Use logical Tailwind classes (`ms-`, `me-`, `ps-`, `start-`, `end-`) so layouts flip in RTL.

## Audit trail

`audit(tx, { actorId, action, entityType, entityId, chapterCode, details })` inside the same transaction as the
change. Viewable in Admin → Audit trail.

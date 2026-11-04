# Adding a module · إضافة وحدة

A module is one shared engine (documents, incidents, CAPA, KPIs…). Every module follows the same recipe, so a
developer who has read one module can read them all. Keep each PR to one module (split big modules into
"data + list", "workflow", "alerts").

Example below: a minimal **CAPA** module.

## 1. Data — `prisma/schema.prisma`

Append a section. Include the tagging columns.

```prisma
// -----------------------------------------------------------------------------
//  MODULE — CAPA (corrective & preventive actions)
// -----------------------------------------------------------------------------
model Capa {
  id           String   @id @default(cuid())
  title        String
  chapterCode  String          // tagging rule
  standardCode String?
  departmentId String?
  ownerId      String
  dueDate      DateTime
  status       String   @default("OPEN")
  createdAt    DateTime @default(now())
  @@index([chapterCode, status])
}
```

Then `npm run db:migrate -- --name capa` and commit the generated folder in `prisma/migrations/`.

## 2. Permissions — `src/core/rbac/permissions.ts`

```ts
"capa.view":   { ar: "عرض الإجراءات التصحيحية", en: "View CAPAs" },
"capa.manage": { ar: "إدارة الإجراءات التصحيحية", en: "Manage CAPAs" },
```

Add them to the right roles in `prisma/seed-data/roles.ts`.

## 3. Events — `src/core/events/catalog.ts`

```ts
"capa.assigned": z.object({ capaId: z.string(), ownerId: z.string() }),
```

## 4. Notifications — `src/core/notifications/catalog.ts`

```ts
"capa.assigned": { label: { ar: "إسناد إجراء تصحيحي", en: "CAPA assigned" }, defaults: { inApp: true, email: true } },
"capa.overdue":  { label: { ar: "إجراء تصحيحي متأخر", en: "CAPA overdue" }, defaults: { inApp: true, email: true }, mandatory: true },
```

## 5. Code — `src/modules/capa/`

```
src/modules/capa/
  actions.ts        "use server" — validate with zod, assertPermission, $transaction { write, audit, publish }
  subscribers.ts    subscribe("capa.assigned", "capa.notify_owner", …) → notify()
  jobs.ts           defineJob({ name: "capa.overdue_scan", everyMinutes: 60, run })
  chapter-tab.tsx   the tab shown on every chapter page, filtered by chapter.code
  components/       module UI pieces
```

A server action always looks like this:

```ts
export async function createCapa(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = schema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };
  const actor = await assertPermission("capa.manage", { chapterCode: parsed.data.chapterCode });
  await db.$transaction(async (tx) => {
    const capa = await tx.capa.create({ data: parsed.data });
    await audit(tx, { actorId: actor.id, action: "capa.create", entityType: "Capa", entityId: capa.id, chapterCode: capa.chapterCode });
    await publish(tx, "capa.assigned", { capaId: capa.id, ownerId: capa.ownerId }, { actorId: actor.id, chapterCode: capa.chapterCode });
  });
  revalidatePath("/[locale]/chapters/[code]", "page");
  return { ok: true };
}
```

## 6. Wire it in (one line each)

| File | Line |
|---|---|
| `src/core/events/subscribers.ts` | `import "@/modules/capa/subscribers";` |
| `src/worker/jobs.ts` | `...capaJobs` |
| `src/modules/chapter-tabs.tsx` | `improvement: CapaTab` |
| `src/core/chapters/tabs.ts` | `ready: true` on the tab |
| `messages/{ar,en}.json` | a `"capa": { … }` namespace |

Pages that are not inside a chapter go in `src/app/[locale]/(app)/capa/`.

## 7. Tests

- Pure logic (status transitions, due-date maths) → `src/modules/capa/*.test.ts`
- Database + events → `tests/integration/capa.test.ts`

## 8. PR checklist

- [ ] Migration committed and `npm run db:migrate` works on a fresh database
- [ ] Records carry `chapterCode` (+ `standardCode`, `departmentId` where relevant)
- [ ] Every write: permission check, audit line, event — in one transaction
- [ ] Arabic and English strings, checked in RTL
- [ ] `npm run lint && npm run typecheck && npm test && npm run test:integration`
- [ ] Module README section added to `docs/roadmap.md`

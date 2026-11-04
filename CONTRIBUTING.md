# Contributing · المساهمة

1. Read [docs/architecture.md](docs/architecture.md) and [docs/adding-a-module.md](docs/adding-a-module.md).
2. Branch from `main`; one module (or one slice of it) per PR.
3. Before pushing: `npm run lint && npm run typecheck && npm test && npm run test:integration`.
4. Schema changes: edit `prisma/schema.prisma`, run `npm run db:migrate -- --name <what>`, commit the migration.
5. Every user-facing string goes in **both** `messages/ar.json` and `messages/en.json`. Check the page in Arabic (RTL).
6. Every write goes through a server action that checks permission, writes, audits and publishes an event in one transaction.

## Conventions

- TypeScript strict; no `any` unless unavoidable and commented.
- Server components by default; `"use client"` only for interaction.
- Import navigation from `@/i18n/navigation`, not `next/link`, so links keep the locale.
- Tailwind logical classes (`ms-`, `pe-`, `start-`, `end-`) instead of `ml-`/`right-`.
- Names: permissions `area.action`, events `entity.past_tense`, notification types `area.what_happened`.

# QMS — نظام إدارة الجودة للمستشفى

نظام ويب متكامل لإدارة الجودة والاعتماد في المستشفى وفق معايير **سباهي (CBAHI)** مع مقابلها في **JCI**.
يكمّل بوابة المستشفى الحالية (Aya Operation System) ونظام FMS، ولا يستبدلهما.

> **الفكرة باختصار:** فصول سباهي (القيادة، الجودة، مكافحة العدوى، FMS...) هي واجهة النظام،
> وتحتها **محركات مشتركة** يستخدمها كل فصل: المعايير، الوثائق، الحوادث، الإجراءات التصحيحية، المؤشرات...
> كل سجل يحمل رمز **الفصل + المعيار + القسم**، فيظهر تلقائياً في صفحة فصله وفي لوحة الإدارة.

| | |
|---|---|
| الواجهة | عربي (RTL) وإنجليزي، تعمل على الجوال |
| الإشعارات | داخل النظام (جرس) + بريد إلكتروني، مع تفضيلات لكل مستخدم |
| الصلاحيات | أدوار على مستوى المستشفى أو مقيّدة بقسم أو فصل |
| الربط | واجهة API بمفاتيح لنظام FMS والبوابة ونظام المستشفى (HIS) |
| التدقيق | كل تغيير مهم يُسجّل في سجل التدقيق |

**English summary:** a hospital Quality Management System. CBAHI chapters are the navigation; shared engines
(standards, documents, incidents, CAPA, KPIs…) sit underneath and every record is tagged with chapter + standard +
department. Arabic/English UI, in-app + e-mail alerts, scoped RBAC, audit trail and an API for the FMS system and the portal.

---

## التشغيل السريع (Quick start)

المتطلبات: Node.js 22، و Docker (أو PostgreSQL 14+ مثبت محلياً).

```bash
git clone https://github.com/adobecreative/QMS-p1.git && cd QMS-p1
cp .env.example .env              # ثم ضع AUTH_SECRET:  npx auth secret
docker compose up -d              # PostgreSQL + Mailpit (بريد تجريبي على http://localhost:8025)
npm install
npm run db:migrate                # إنشاء الجداول
npm run db:seed                   # الفصول والأقسام والأدوار وحساب المدير
npm run dev                       # الواجهة: http://localhost:3000
npm run dev:worker                # في نافذة ثانية: الأحداث والبريد والتنبيهات المجدولة
```

الدخول: `admin@hospital.local` / `ChangeMe!2026` (غيّرها من «ملفي» أو من `.env` قبل التهيئة).

## الأوامر

| الأمر | الوظيفة |
|---|---|
| `npm run dev` / `npm run dev:worker` | تشغيل الواجهة والعامل أثناء التطوير |
| `npm run build` / `npm start` / `npm run worker` | البناء والتشغيل للإنتاج |
| `npm run lint` / `npm run typecheck` | فحص الكود |
| `npm test` | اختبارات الوحدات (بدون قاعدة بيانات) |
| `npm run test:integration` | اختبارات التكامل على قاعدة `qms_test` |
| `npm run db:migrate` | إنشاء migration بعد تعديل `prisma/schema.prisma` |
| `npm run db:seed` | تهيئة البيانات الأساسية (آمن للتكرار) |

## التقنيات

| الطبقة | التقنية | لماذا |
|---|---|---|
| الواجهة والخادم | [Next.js 15](https://nextjs.org/docs) (App Router) + React 19 + TypeScript | الأكثر انتشاراً وتوثيقاً، مشروع واحد للواجهة والخادم |
| قاعدة البيانات | PostgreSQL + [Prisma](https://www.prisma.io/docs) | مخطط واضح في ملف واحد، migrations تلقائية |
| الدخول | [Auth.js](https://authjs.dev) — كلمة مرور، و Microsoft 365 اختيارياً | المستشفى يستخدم Microsoft 365 أصلاً |
| الترجمة | [next-intl](https://next-intl.dev) | عربي/إنجليزي مع RTL |
| التنسيق | [Tailwind CSS 4](https://tailwindcss.com/docs) + أيقونات lucide | بدون مكتبات واجهة ثقيلة |
| التحقق | [Zod](https://zod.dev) | نفس المخطط للنماذج والـAPI |
| البريد | Nodemailer (SMTP) | يعمل مع Exchange/Office 365 أو أي خادم بريد |
| الاختبارات | Vitest | سريع ومتوافق مع TypeScript |

## خريطة المشروع

```
prisma/schema.prisma        مخطط قاعدة البيانات (قسم لكل وحدة)
prisma/seed.ts              الفصول والأقسام والأدوار وحساب المدير
messages/{ar,en}.json       نصوص الواجهة
src/core/                   الأساس المشترك (لا يعرف شيئاً عن الوحدات)
  auth/  rbac/              الدخول والصلاحيات
  events/                   ناقل الأحداث (outbox) والمشتركون
  notifications/            الإشعارات والبريد والتفضيلات
  jobs/                     المهام المجدولة
  audit/  integrations/     سجل التدقيق ومفاتيح الـAPI
  chapters/tabs.ts          قالب الفصل الموحد (التبويبات)
src/modules/<module>/       منطق كل وحدة: actions و components و subscribers
src/app/[locale]/(app)/     الصفحات
src/app/api/                واجهة API (v1 للأنظمة الخارجية)
src/worker/                 العامل: الأحداث والبريد والجدولة
tests/integration/          اختبارات على قاعدة بيانات حقيقية
docs/                       الوثائق
```

## الوثائق

- [المعمارية](docs/architecture.md) — الطبقات، ناقل الأحداث، الإشعارات، الصلاحيات
- [إضافة وحدة جديدة](docs/adding-a-module.md) — خطوة بخطوة لأي مبرمج
- [الربط مع الأنظمة](docs/integrations.md) — FMS، البوابة، HIS
- [المعايير: سباهي و JCI](docs/standards.md)
- [خطة الوحدات](docs/roadmap.md) — ترتيب الـPRs
- [المساهمة](CONTRIBUTING.md)

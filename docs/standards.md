# Standards · المعايير (CBAHI · JCI)

## Chapters

The chapters seeded on day one are the ones on the hospital portal. The JCI column is a **suggested mapping**
for hospitals that also prepare for JCI; edit it in Admin → Chapters.

| CBAHI | Chapter | الفصل | JCI (suggested) |
|---|---|---|---|
| ESR | Essential Safety Requirements | متطلبات السلامة الأساسية | IPSG |
| LD | Leadership | القيادة | GLD |
| QM | Quality Management & Patient Safety | إدارة الجودة وسلامة المرضى | QPS |
| MM | Medication Management | إدارة الأدوية | MMU |
| FMS | Facility Management & Safety | إدارة المنشأة والسلامة | FMS |
| IPC | Infection Prevention & Control | مكافحة العدوى | PCI |
| NR | Nursing Care | التمريض | COP, SQE |
| LB | Laboratory | المختبر | AOP |
| MS | Medical Staff | الطاقم الطبي | SQE |

Other chapters (for example Radiology, Provision of Care, Anesthesia) are added in Admin → Chapters with no code change.

## Standards catalogue (module 2)

The text of the CBAHI and JCI standards is published by those bodies and licensed to the hospital, so it is
**not shipped in this repository**. The Standards module provides:

- an importer (CSV/Excel) for the hospital's own edition: code, chapter, standard text (ar/en), ESR flag,
  measurable elements, JCI cross-reference;
- self-assessment per standard (met / partially met / not met / not applicable) with evidence links to
  documents, KPIs, audits and meeting minutes;
- readiness % per chapter and for ESR, shown on each chapter overview and the executive dashboard.

Record `standardCode` on every module record that is evidence for a standard; readiness is then computed, not typed.

/**
 * System roles. Module PRs extend the permission lists. Roles marked
 * isSystem are reset to these defaults on every `npm run db:seed`; create your
 * own roles in Admin → Roles to customise.
 */
export const roles = [
  {
    key: "SYSTEM_ADMIN",
    nameEn: "System administrator",
    nameAr: "مدير النظام",
    descriptionEn: "Full access, including configuration and integrations.",
    descriptionAr: "صلاحية كاملة بما فيها الإعدادات والربط مع الأنظمة.",
    permissions: ["*"],
  },
  {
    key: "QUALITY_DIRECTOR",
    nameEn: "Quality director",
    nameAr: "مدير الجودة",
    descriptionEn: "Oversees all chapters, receives escalations, sends announcements.",
    descriptionAr: "يشرف على كل الفصول ويستقبل التصعيدات ويرسل التعاميم.",
    permissions: ["users.view", "audit.view", "notifications.broadcast", "dashboard.executive"],
  },
  {
    key: "QUALITY_COORDINATOR",
    nameEn: "Quality coordinator",
    nameAr: "منسق الجودة",
    descriptionEn: "Works across chapters on standards, documents and improvement.",
    descriptionAr: "يعمل عبر الفصول على المعايير والوثائق والتحسين.",
    permissions: ["users.view"],
  },
  {
    key: "CHAPTER_LEAD",
    nameEn: "Chapter lead",
    nameAr: "مسؤول الفصل",
    descriptionEn: "Owns one chapter. Assign it scoped to that chapter.",
    descriptionAr: "مسؤول عن فصل واحد. يُسند مقيّداً بذلك الفصل.",
    permissions: [],
  },
  {
    key: "DEPARTMENT_HEAD",
    nameEn: "Department head",
    nameAr: "رئيس القسم",
    descriptionEn: "Manages records of one department. Assign it scoped to that department.",
    descriptionAr: "يدير سجلات قسم واحد. يُسند مقيّداً بذلك القسم.",
    permissions: ["users.view"],
  },
  {
    key: "EXECUTIVE",
    nameEn: "Executive",
    nameAr: "الإدارة التنفيذية",
    descriptionEn: "Read access to dashboards and reports.",
    descriptionAr: "اطلاع على لوحات الإدارة والتقارير.",
    permissions: ["dashboard.executive"],
  },
  {
    key: "STAFF",
    nameEn: "Staff",
    nameAr: "موظف",
    descriptionEn: "Every employee: reads policies, reports incidents, receives alerts.",
    descriptionAr: "كل موظف: يقرأ السياسات ويبلغ عن الحوادث ويستقبل التنبيهات.",
    permissions: [],
  },
];

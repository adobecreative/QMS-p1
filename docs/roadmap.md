# Roadmap · خطة الوحدات

Each step is one or more reviewable PRs. Every module plugs into the foundation the same way
(see [adding-a-module.md](adding-a-module.md)) and fills one tab of the unified chapter template.

| # | Module | Chapter tab | Main content | Alerts |
|---|---|---|---|---|
| 1 | **Foundation** ✅ | Overview | users, departments, roles (scoped), chapters, event bus, notifications (in-app + e-mail), scheduler, audit trail, API for FMS/portal, Arabic/English | welcome, role changes, announcements, external alerts |
| 2 | Standards & self-assessment | Standards | CBAHI catalogue importer, ESR flags, JCI cross-reference, self-assessment, evidence links, readiness % | assessment due, standard not met |
| 3 | Documents & policies | Policies & documents | versions, review/approval workflow, annual review, read-and-acknowledge; expiry registers (facility licenses, contracts, contracted services) | review due 90/60/30 days, approval requests, license/contract expiry |
| 4 | Incidents (OVR) & complaints | Incidents & improvement | OVR reporting (anonymous option), severity grading, sentinel events, RCA, FMEA, risk register, patient complaints | new incident to department head + quality, sentinel event escalation, complaint SLA |
| 5 | CAPA | Incidents & improvement | actions from any source (incident, audit, committee, KPI), owner, due date, effectiveness check | assigned, due soon, overdue escalation |
| 6 | KPIs & executive dashboard | KPIs | KPI definitions (numerator/denominator/target/owner), monthly entry or API feed, trends, red flags → CAPA, unified executive dashboard, Power BI read view | data entry reminders, target breached |
| 7 | People & competency | Staff & competency | staff licenses (SCFHS), competencies, training, medical staff credentialing & privileging, OPPE/FPPE | license expiry, competency due |
| 8 | Committees & meetings | Committees & meetings | annual schedule, quorum, minutes, decisions as tracked tasks | meeting reminders, decision overdue |
| 9 | Audits, rounds & surveys | Incidents & improvement | configurable checklists (mobile), safety rounds, hand-hygiene, tracers, satisfaction & safety-culture surveys | scheduled audit due, findings → CAPA |
| 10 | Integrations | — | FMS events → incidents/KPIs, HIS census feed, portal links | — |

# Integrations · الربط مع الأنظمة

QMS does not rebuild systems the hospital already has. They connect through a small HTTP API.

## 1. Create an API client

Admin → Integrations → New API client. The **name** becomes the event namespace (`fms`, `portal`, `his`).
The key (`qms_<prefix>_<secret>`) is shown once; only its hash is stored. Disable a client to revoke it.

Scopes:

| Scope | Allows |
|---|---|
| `events:write` | `POST /api/v1/events` |
| `reference:read` | `GET /api/v1/chapters`, `GET /api/v1/departments` |

All calls send `Authorization: Bearer <key>`.

## 2. Send events — `POST /api/v1/events`

```http
POST /api/v1/events
Authorization: Bearer qms_1a2b3c4d_…
Content-Type: application/json

{
  "type": "work_order.overdue",
  "externalId": "WO-1001",
  "occurredAt": "2026-11-04T08:00:00Z",
  "chapterCode": "FMS",
  "entityType": "WorkOrder",
  "entityId": "WO-1001",
  "payload": {
    "asset": "Fire pump #2",
    "alert": {
      "severity": "CRITICAL",
      "title": { "ar": "أمر عمل متأخر: مضخة الحريق ٢", "en": "Overdue work order: fire pump #2" },
      "body":  { "ar": "تجاوز موعد الصيانة الوقائية.", "en": "Preventive maintenance is overdue." },
      "link": "https://fms.hospital.local/work-orders/1001",
      "audience": { "roleKeys": ["QUALITY_DIRECTOR"], "chapterLeadsOf": ["FMS"] }
    }
  }
}
```

| Field | Notes |
|---|---|
| `type` | lowercase dotted name; stored as `external.<client>.<type>` |
| `externalId` | idempotency key — sending the same id again returns `"duplicate"` and changes nothing |
| `chapterCode` | the chapter the event belongs to |
| `payload` | free JSON defined by the sending system |
| `payload.alert` | optional: raises an in-app + e-mail alert in QMS (see below) |

Responses: `202 accepted`, `200 duplicate`, `400 invalid_body`, `401 unauthorized`.

### Alert envelope

| Field | Default |
|---|---|
| `severity` | `WARNING` (`INFO`, `SUCCESS`, `WARNING`, `CRITICAL`) |
| `title` | required `{ ar, en }` |
| `body` | optional `{ ar, en }` |
| `link` | optional absolute URL back to the source system |
| `audience` | `{ "roleKeys": ["QUALITY_DIRECTOR"] }`; also `userIds`, `departmentIds`, `departmentHeadsOf`, `chapterLeadsOf`, `all` |

Later modules subscribe to specific external events, for example `external.fms.work_order.failed` → open an
incident in the FMS chapter.

### curl

```bash
curl -X POST "$QMS_URL/api/v1/events" -H "Authorization: Bearer $QMS_KEY" -H 'Content-Type: application/json' \
  -d '{"type":"work_order.overdue","externalId":"WO-1001","chapterCode":"FMS","payload":{}}'
```

## 3. Reference data

`GET /api/v1/chapters` returns active chapters with Arabic/English names, JCI codes, colour and deep links:

```json
{ "data": [ { "code": "IPC", "nameEn": "Infection Prevention & Control", "nameAr": "مكافحة العدوى",
  "jciCodes": ["PCI"], "color": "#15803d",
  "url": { "ar": "https://qms…/ar/chapters/IPC", "en": "https://qms…/en/chapters/IPC" } } ] }
```

`GET /api/v1/departments` returns departments with `code`, names and `parentCode`.

## 4. The portal (SharePoint)

Point each chapter tile on the portal to `https://<qms>/ar/chapters/<CODE>`. With Microsoft 365 sign-in enabled
(`AUTH_MICROSOFT_ENTRA_ID_*`), staff open QMS without a second password. Links to individual tabs:
`/ar/chapters/IPC?tab=documents`.

## 5. Health check

`GET /api/health` → `{ "status": "ok", "database": "ok", "pendingEvents": 0 }` (503 when the database is down).

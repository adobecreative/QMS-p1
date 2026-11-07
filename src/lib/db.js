// Database set-up, settings and the activity log.
import { DEFAULT_SETTINGS, SLA_KEYS } from './config.js';
import { MIGRATIONS, SCHEMA } from './schema.js';
import { seedAssetTypes, seedStarter } from './seed.js';
import { nowIso } from './util.js';

/* ------------------------------- database -------------------------------- */

export let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  const found = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").first();
  if (!found) await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  await env.DB.batch(MIGRATIONS.map((sql) => env.DB.prepare(sql)));
  // Optional English file name, shown when the interface is in English. ALTER TABLE has no IF NOT EXISTS.
  const { results: cols } = await env.DB.prepare('PRAGMA table_info(files)').all();
  if (!cols.some((c) => c.name === 'name_en')) await env.DB.prepare('ALTER TABLE files ADD COLUMN name_en TEXT').run();
  // The CBAHI chapter a file belongs to (std_chapters.code), so it shows on that chapter's page. Optional.
  if (!cols.some((c) => c.name === 'chapter')) await env.DB.prepare('ALTER TABLE files ADD COLUMN chapter TEXT').run();
  // Standards frameworks: older databases had CBAHI only, with the chapter code as the key. SQLite cannot
  // change a key in place, so both tables are copied once into the new shape (every row becomes CBAHI).
  const { results: chCols } = await env.DB.prepare('PRAGMA table_info(std_chapters)').all();
  if (!chCols.some((c) => c.name === 'framework')) {
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE std_chapters_v2 (framework TEXT NOT NULL DEFAULT 'cbahi', code TEXT NOT NULL, name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
          jci TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (framework, code))`,
      ),
      env.DB.prepare(`INSERT INTO std_chapters_v2 (framework, code, name_ar, name_en, jci, sort, active) SELECT 'cbahi', code, name_ar, name_en, jci, sort, active FROM std_chapters`),
      env.DB.prepare('DROP TABLE std_chapters'),
      env.DB.prepare('ALTER TABLE std_chapters_v2 RENAME TO std_chapters'),
      env.DB.prepare(
        `CREATE TABLE standards_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, framework TEXT NOT NULL DEFAULT 'cbahi', chapter TEXT NOT NULL, code TEXT NOT NULL,
          title_ar TEXT NOT NULL, title_en TEXT NOT NULL, esr INTEGER NOT NULL DEFAULT 0, jci TEXT, department_id INTEGER, active INTEGER NOT NULL DEFAULT 1,
          score TEXT, note TEXT, evidence TEXT, assessed_at TEXT, assessed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (framework, code))`,
      ),
      env.DB.prepare(
        `INSERT INTO standards_v2 (id, framework, chapter, code, title_ar, title_en, esr, jci, department_id, active, score, note, evidence, assessed_at, assessed_by, created_at, updated_at)
          SELECT id, 'cbahi', chapter, code, title_ar, title_en, esr, jci, department_id, active, score, note, evidence, assessed_at, assessed_by, created_at, updated_at FROM standards`,
      ),
      env.DB.prepare('DROP TABLE standards'),
      env.DB.prepare('ALTER TABLE standards_v2 RENAME TO standards'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_standards_chapter ON standards(chapter, active)'),
    ]);
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_standards_fw ON standards(framework, chapter, active)').run();
  // An assessment row can be about one element of the standard (std_elements.id).
  const { results: saCols } = await env.DB.prepare('PRAGMA table_info(std_assessments)').all();
  if (!saCols.some((c) => c.name === 'element_id')) await env.DB.prepare('ALTER TABLE std_assessments ADD COLUMN element_id INTEGER').run();
  // A technical department (IT, biomedical, maintenance) receives tickets. Technicians carry a job title.
  const { results: deptCols } = await env.DB.prepare('PRAGMA table_info(departments)').all();
  if (!deptCols.some((c) => c.name === 'is_team')) await env.DB.prepare('ALTER TABLE departments ADD COLUMN is_team INTEGER NOT NULL DEFAULT 0').run();
  // A team can have new requests handed out on their own, to the technician with the fewest open ones.
  if (!deptCols.some((c) => c.name === 'auto_assign')) await env.DB.prepare('ALTER TABLE departments ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0').run();
  // repeat_n: how many requests of the same type came from the same place or device in 30 days (3 or more).
  const { results: ticketCols } = await env.DB.prepare('PRAGMA table_info(tickets)').all();
  if (!ticketCols.some((c) => c.name === 'repeat_n')) await env.DB.prepare('ALTER TABLE tickets ADD COLUMN repeat_n INTEGER NOT NULL DEFAULT 0').run();
  // A ticket can be about a registered asset; a planned job (pm_plan_id) carries the date it was due.
  if (!ticketCols.some((c) => c.name === 'asset_id')) {
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN asset_id INTEGER'),
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN pm_plan_id INTEGER'),
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN pm_due TEXT'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tickets_asset ON tickets(asset_id)'),
    ]);
  }
  // A request sent to a supplier: which one, under which contract, when it was sent and when the supplier came.
  if (!ticketCols.some((c) => c.name === 'vendor_id')) {
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN vendor_id INTEGER'),
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN contract_id INTEGER'),
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN vendor_called_at TEXT'),
      env.DB.prepare('ALTER TABLE tickets ADD COLUMN vendor_arrived_at TEXT'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tickets_vendor ON tickets(vendor_id)'),
    ]);
  }
  // The finance code a department's maintenance costs are charged to in the ERP.
  if (!deptCols.some((c) => c.name === 'cost_center')) await env.DB.prepare('ALTER TABLE departments ADD COLUMN cost_center TEXT').run();
  const { results: userCols } = await env.DB.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'job_title')) await env.DB.prepare('ALTER TABLE users ADD COLUMN job_title TEXT').run();
  // Two-step sign-in. totp_step is the last 30-second step used, so a code cannot be used twice.
  if (!userCols.some((c) => c.name === 'totp_on')) {
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE users ADD COLUMN totp_secret TEXT'),
      env.DB.prepare('ALTER TABLE users ADD COLUMN totp_pending TEXT'),
      env.DB.prepare('ALTER TABLE users ADD COLUMN totp_on INTEGER NOT NULL DEFAULT 0'),
      env.DB.prepare('ALTER TABLE users ADD COLUMN totp_step INTEGER NOT NULL DEFAULT 0'),
    ]);
  }
  // Every record is named in Arabic and English. Older people get their one name in both until edited.
  if (!userCols.some((c) => c.name === 'name_en')) await env.DB.batch([env.DB.prepare('ALTER TABLE users ADD COLUMN name_en TEXT'), env.DB.prepare('UPDATE users SET name_en = name')]);
  // An asset's kind comes from asset_types (it first came from the problem types, which list faults, not devices).
  // Assets made before get a device type of the same name and team, once.
  const { results: assetCols } = await env.DB.prepare('PRAGMA table_info(assets)').all();
  if (!assetCols.some((c) => c.name === 'type_id')) {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE assets ADD COLUMN type_id INTEGER'),
      env.DB.prepare(
        `INSERT INTO asset_types (name_ar, name_en, team_id, active, created_at)
         SELECT DISTINCT c.name_ar, c.name_en, c.team_id, 1, ? FROM assets a JOIN ticket_categories c ON c.id = a.category_id`,
      ).bind(now),
      env.DB.prepare(
        `UPDATE assets SET type_id = (SELECT t.id FROM asset_types t JOIN ticket_categories c ON c.name_ar = t.name_ar AND c.team_id = t.team_id WHERE c.id = assets.category_id LIMIT 1)
          WHERE category_id IS NOT NULL`,
      ),
    ]);
  }
  // Planned work goes to each team under its own hidden problem type (pm = 1), never offered on the request form.
  const { results: catCols } = await env.DB.prepare('PRAGMA table_info(ticket_categories)').all();
  if (!catCols.some((c) => c.name === 'pm')) await env.DB.prepare('ALTER TABLE ticket_categories ADD COLUMN pm INTEGER NOT NULL DEFAULT 0').run();
  if (!userCols.some((c) => c.name === 'assets_role')) await env.DB.prepare("ALTER TABLE users ADD COLUMN assets_role TEXT NOT NULL DEFAULT 'none'").run();
  if (!userCols.some((c) => c.name === 'rounds_role')) await env.DB.prepare("ALTER TABLE users ADD COLUMN rounds_role TEXT NOT NULL DEFAULT 'none'").run();
  if (!userCols.some((c) => c.name === 'quality_role')) await env.DB.prepare("ALTER TABLE users ADD COLUMN quality_role TEXT NOT NULL DEFAULT 'none'").run();
  if (!userCols.some((c) => c.name === 'meetings_role')) await env.DB.prepare("ALTER TABLE users ADD COLUMN meetings_role TEXT NOT NULL DEFAULT 'none'").run();
  const { results: roundCols } = await env.DB.prepare('PRAGMA table_info(rounds)').all();
  if (!roundCols.some((c) => c.name === 'scanned')) await env.DB.prepare('ALTER TABLE rounds ADD COLUMN scanned INTEGER NOT NULL DEFAULT 0').run();
  const { results: staffCols } = await env.DB.prepare('PRAGMA table_info(staff)').all();
  if (!staffCols.some((c) => c.name === 'name_en')) await env.DB.batch([env.DB.prepare('ALTER TABLE staff ADD COLUMN name_en TEXT'), env.DB.prepare('UPDATE staff SET name_en = name')]);
  // A role per system. Accounts made before the portal keep what they could do: their old single role
  // becomes the matching role in each system (once, when the columns are added).
  if (!userCols.some((c) => c.name === 'docs_role')) {
    await env.DB.batch([
      env.DB.prepare("ALTER TABLE users ADD COLUMN docs_role TEXT NOT NULL DEFAULT 'none'"),
      env.DB.prepare("ALTER TABLE users ADD COLUMN desk_role TEXT NOT NULL DEFAULT 'none'"),
      env.DB.prepare(
        `UPDATE users SET
           docs_role = CASE role WHEN 'dept_admin' THEN 'dept_admin' WHEN 'super_admin' THEN 'none' ELSE 'viewer' END,
           desk_role = CASE role
             WHEN 'technician' THEN 'technician'
             WHEN 'dept_admin' THEN CASE WHEN (SELECT is_team FROM departments d WHERE d.id = users.department_id) = 1 THEN 'supervisor' ELSE 'dept' END
             ELSE 'none' END,
           role = CASE role WHEN 'super_admin' THEN 'super_admin' ELSE 'user' END`,
      ),
    ]);
  }
  // Hospital departments, teams and common problem types, once per database.
  if (!(await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = 'starter_seeded'").first())) await seedStarter(env);
  // Common device types, once, after the teams they belong to exist.
  if (!(await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = 'asset_types_seeded'").first())) await seedAssetTypes(env);
  schemaReady = true;
}

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const row of results) if (row.key in s) s[row.key] = row.value;
  s.near_days = Number(s.near_days);
  s.repeat_days = Number(s.repeat_days);
  for (const k of SLA_KEYS) s[k] = Number(s[k]);
  s.ai_daily_limit = Number(s.ai_daily_limit);
  return s;
}
export const setSettingStmt = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

export function logStmt(env, user, action, entity, entityId, label, details) {
  return env.DB.prepare('INSERT INTO logs (at, user_id, user_name, action, entity, entity_id, label, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
    nowIso(),
    user ? user.id : null,
    user ? user.name : 'system',
    action,
    entity,
    entityId ?? null,
    label ?? null,
    details && Object.keys(details).length ? JSON.stringify(details) : null,
  );
}

export function changes(before, after, keys) {
  const out = {};
  for (const k of keys) {
    const a = before[k] ?? null;
    const b = after[k] ?? null;
    if (a !== b) out[k] = [a, b];
  }
  return out;
}
